import type { Express, Request } from 'express';
import * as fs from 'node:fs';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as childProcess from 'node:child_process';
import matter from 'gray-matter';
import { renderConsoleHtml } from './console.js';
import {
  BASE_DIR,
  DEFAULT_MODELS,
  LOCAL_MCP_ENABLED,
  MODEL_ENV_KEYS,
  getModelSettingsSnapshot,
  getOpenAiApiKey,
  getRuntimeEnv,
  normalizeModelId,
  type ModelTier,
} from '../config.js';
import { getComposioRuntimeStatus } from '../integrations/composio/client.js';
import { getGitHubCliStatus } from '../integrations/github-cli.js';
import { recallHybrid, getRecallStats } from '../memory/recall.js';
import { bufferToVector, readEmbeddingStats } from '../memory/embeddings.js';
import { FACT_KINDS, forgetFact, getFact, listActiveFacts, listAllFacts, rememberFact, searchFacts, setFactPinned, updateFact } from '../memory/facts.js';
import { openMemoryDb } from '../memory/db.js';
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
import { ensureDir, getWorkspaceDirs, listWorkspaceProjects, parseTasks, readBaseEnv, updateEnvKey, GOALS_DIR, TASKS_FILE, WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  deleteWorkflow,
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  type WorkflowDefinition,
} from '../memory/workflow-store.js';
import { subscribeWorkflowChanges } from '../memory/workflow-change-bus.js';
import { extractArchitectDiff } from './architect-diff.js';
import { appendWorkflowEvent, listPendingRuns, readWorkflowEvents } from '../execution/workflow-events.js';
import {
  validateWorkflowDefinition as runValidator,
  type WorkflowValidation,
} from '../execution/workflow-validator.js';
import { checkWorkflowForWrite } from '../execution/workflow-enforce.js';
import { ExecutionStore } from '../execution/store.js';
import { listOpenCheckIns } from '../agents/check-ins.js';
import type { ClementineAssistant } from '../assistant/core.js';
import type { PendingApproval } from '../types.js';
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
import { SKILLS_DIR, listSkills, uninstallSkill } from '../memory/skill-store.js';
import { checkAllSkillUpdates, getSkillInstallJob, startSkillInstall, startSkillUpdate } from '../runtime/skill-installer.js';
import { getProactivityPolicySnapshot, loadProactivityPolicy, saveProactivityPolicy } from '../agents/proactivity-policy.js';
import { getAuthStatus, loginWithNativeOAuth } from '../runtime/auth-store.js';
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
  deletePlanProposal,
  getPlanProposal,
  listPlanProposals,
  planProposalNeedsUserInput,
  rejectPlanProposal,
} from '../agents/plan-proposals.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import {
  clearGoalState,
  describeGoalState,
  loadGoalState,
  parseGoalCommand,
  runGoalLoop,
  type GoalCommand,
} from '../agents/goal-loop.js';
import { PlanSchema } from '../agents/planner.js';
import { closePlanScope, listActiveScopes, listAllScopes } from '../agents/plan-scope.js';
import type { CheckInUrgency } from '../agents/check-ins.js';
import { createBackgroundTask, getBackgroundTask, listBackgroundTasks, processBackgroundTasks } from '../execution/background-tasks.js';
import { getBackgroundTaskStatus } from '../execution/background-task-status.js';
import { listRuns } from '../runtime/run-events.js';
import { addNotification, listNotifications, markStaleApprovalNotificationsRead } from '../runtime/notifications.js';
import { actionBus, type ActionEvent } from '../runtime/action-bus.js';
import {
  appendEvent as appendHarnessEvent,
  createSession as createHarnessSession,
  getLatestEventSeq as getLatestHarnessEventSeq,
  getSession as getHarnessSession,
  requestKill as requestHarnessKill,
  listEvents as listHarnessEvents,
  listSessions as listHarnessSessions,
  summarizeSessionForSignal,
  type EventRow as HarnessEventRow,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { runConversation, runConversationFromResume } from '../runtime/harness/loop.js';
import { runPlanFirstPreflight, shouldUsePlanFirst } from '../runtime/harness/plan-first.js';
import { routeOpenQuestionPlan } from '../runtime/harness/plan-continuity.js';
import { getHarnessBudgetSnapshot, saveHarnessBudgetSettings } from '../runtime/harness/budget-settings.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { parseApprovalIntent, parseHarnessCommand } from '../channels/discord-harness.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import { summarizeApprovalAction } from '../runtime/approval-summary.js';
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
import { listMcpServerHealth } from '../runtime/mcp-namespace-shim.js';
import { collectDiagnostics } from './diagnostics.js';
import {
  findCatalogEntry,
  forgetConnectedCli,
  readConnectedClis,
  recordConnectedCli,
  statusForSearchResults,
} from '../integrations/cli-catalog/catalog.js';

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
  dependsOn?: string[];
  model?: string;
  tier?: number;
  maxTurns?: number;
}
interface WorkflowFrontmatter {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: { schedule?: string; manual?: boolean };
  steps?: WorkflowStepShape[];
  inputs?: Record<string, { type?: string; default?: string; description?: string }>;
  synthesis?: { prompt?: string };
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

// ── Semantic 3D layout for the knowledge graph ──────────────────────
// Project fact embeddings (1536-dim) → 3D via PCA so semantically similar
// facts cluster in space. Uses the Gram-matrix trick (features ≫ samples):
// the top-3 eigenvectors of the N×N Gram matrix give the PCA scores
// directly as score_k(i) = √λ_k · u_k[i]. Dependency-free power iteration;
// N ≤ 300 so this is cheap. Result cached by fact-set signature.
let semanticPosCache: { key: string; positions: Map<number, [number, number, number]> } | null = null;

function computeSemanticFactPositions(
  db: ReturnType<typeof openMemoryDb>,
  factIds: number[],
): Map<number, [number, number, number]> | null {
  if (factIds.length < 4) return null;
  const key = factIds.slice().sort((a, b) => a - b).join(',');
  if (semanticPosCache && semanticPosCache.key === key) return semanticPosCache.positions;

  const placeholders = factIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT fact_id, vector FROM fact_embeddings WHERE fact_id IN (${placeholders})`,
  ).all(...factIds) as Array<{ fact_id: number; vector: Buffer }>;
  if (rows.length < 4) return null;

  const ids: number[] = [];
  const vecs: Float32Array[] = [];
  for (const r of rows) {
    const v = bufferToVector(r.vector);
    if (v && v.length > 0) { ids.push(r.fact_id); vecs.push(v); }
  }
  const n = vecs.length;
  if (n < 4) return null;
  const dim = vecs[0].length;

  // Center the vectors (subtract the mean) — PCA operates on centered data.
  const mean = new Float64Array(dim);
  for (const v of vecs) for (let d = 0; d < dim; d++) mean[d] += v[d];
  for (let d = 0; d < dim; d++) mean[d] /= n;
  const centered: Float64Array[] = vecs.map((v) => {
    const c = new Float64Array(dim);
    for (let d = 0; d < dim; d++) c[d] = v[d] - mean[d];
    return c;
  });

  // Gram matrix G = Xc · Xcᵀ  (n × n, symmetric).
  const G: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const gi = new Float64Array(n);
    for (let j = 0; j <= i; j++) {
      let dot = 0;
      const a = centered[i], b = centered[j];
      for (let d = 0; d < dim; d++) dot += a[d] * b[d];
      gi[j] = dot;
      if (j < i) G[j][i] = dot; // symmetric fill
    }
    G.push(gi);
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) G[i][j] = G[j][i];

  // Deterministic non-degenerate seed (no Math.random → stable + cacheable).
  const seed = (i: number) => Math.sin((i + 1) * 12.9898) * 43758.5453 % 1;
  const matVec = (M: Float64Array[], x: Float64Array) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const row = M[i]; for (let j = 0; j < n; j++) s += row[j] * x[j]; y[i] = s; }
    return y;
  };
  const norm = (x: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += x[i] * x[i]; return Math.sqrt(s); };

  // Power iteration + deflation for the top 3 eigenpairs.
  const comps: Array<{ vec: Float64Array; val: number }> = [];
  const work = G.map((r) => Float64Array.from(r)); // deflated copy
  for (let k = 0; k < 3; k++) {
    let x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = seed(i + k * 7) || 0.01;
    let nrm = norm(x) || 1;
    for (let i = 0; i < n; i++) x[i] /= nrm;
    let lambda = 0;
    for (let iter = 0; iter < 100; iter++) {
      const y = matVec(work, x);
      nrm = norm(y);
      if (nrm < 1e-9) break;
      for (let i = 0; i < n; i++) y[i] /= nrm;
      let diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(y[i] - x[i]);
      x = y;
      lambda = nrm;
      if (diff < 1e-6) break;
    }
    comps.push({ vec: x, val: lambda });
    // Deflate: work -= lambda · x xᵀ
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) work[i][j] -= lambda * x[i] * x[j];
  }

  // Scores: coord_k(i) = √λ_k · u_k[i]. Then scale to a pleasant range.
  const coords: Array<[number, number, number]> = [];
  let maxAbs = 1e-6;
  for (let i = 0; i < n; i++) {
    const c: [number, number, number] = [
      Math.sqrt(Math.max(0, comps[0].val)) * comps[0].vec[i],
      Math.sqrt(Math.max(0, comps[1].val)) * comps[1].vec[i],
      Math.sqrt(Math.max(0, comps[2].val)) * comps[2].vec[i],
    ];
    coords.push(c);
    maxAbs = Math.max(maxAbs, Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]));
  }
  const scale = 160 / maxAbs;
  const positions = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    positions.set(ids[i], [coords[i][0] * scale, coords[i][1] * scale, coords[i][2] * scale]);
  }

  semanticPosCache = { key, positions };
  return positions;
}

function contextFileForKey(key: string): ContextFileDefinition | undefined {
  return CONTEXT_FILES.find((file) => file.key === key);
}

function trimConsoleTitle(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, Math.max(0, max - 1)) + '…' : clean;
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

function isHarnessTerminalEvent(type: HarnessEventRow['type']): boolean {
  return type === 'conversation_completed'
    || type === 'run_completed'
    || type === 'run_failed'
    || type === 'approval_requested'
    || type === 'awaiting_user_input'
    || type === 'conversation_limit_exceeded';
}

function isHarnessSessionCurrentlyWorking(session: HarnessSessionRow, activeWindowCutoff: number): boolean {
  if (session.status !== 'active') return false;
  const updatedMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedMs) || updatedMs < activeWindowCutoff) return false;
  const latest = listHarnessEvents(session.id, { limit: 1, desc: true })[0];
  if (!latest) return false;
  return !isHarnessTerminalEvent(latest.type);
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

function realtimeNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = getRuntimeEnv(name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Handle a `/goal <...>` slash command coming in through the streaming
 * chat endpoint. Streams progress events so the dashboard can render a
 * "Goal turn N/M" indicator and final summary inline.
 *
 * `status` / `clear` / `resume` are short-circuit responses. `start`
 * drives the Ralph loop in `goal-loop.ts`.
 */
async function handleGoalCommand(opts: {
  command: GoalCommand;
  sessionId: string;
  assistant: ClementineAssistant;
  writeEvent: (event: Record<string, unknown>) => void;
  shouldCancel: () => boolean;
}): Promise<void> {
  const { command, sessionId, assistant, writeEvent, shouldCancel } = opts;

  if (command.kind === 'status') {
    const state = loadGoalState(sessionId);
    writeEvent({
      type: 'done',
      text: describeGoalState(state),
      stoppedReason: 'success',
    });
    return;
  }

  if (command.kind === 'clear') {
    const before = loadGoalState(sessionId);
    clearGoalState(sessionId);
    writeEvent({
      type: 'done',
      text: before
        ? `Goal cleared: "${before.objective}" (was ${before.status} at ${before.turnsUsed}/${before.turnsLimit}).`
        : 'No goal was active. Nothing to clear.',
      stoppedReason: 'success',
    });
    return;
  }

  const existing = loadGoalState(sessionId);
  const objective = command.kind === 'resume'
    ? existing?.objective
    : command.kind === 'start'
      ? command.objective
      : undefined;

  if (!objective) {
    writeEvent({
      type: 'done',
      text: 'No goal to resume in this session. Use `/goal <objective>` to start one.',
      stoppedReason: 'success',
    });
    return;
  }

  if (command.kind === 'resume' && existing) {
    writeEvent({
      type: 'status',
      text: `Resuming goal: "${objective}" (was at ${existing.turnsUsed}/${existing.turnsLimit}).`,
    });
  } else {
    writeEvent({ type: 'status', text: `Starting goal: "${objective}"` });
  }

  const result = await runGoalLoop({
    sessionId,
    objective,
    runtime: assistant.getRuntime(),
    shouldCancel: () => shouldCancel(),
    onTurnStart: ({ turn, total }) => {
      writeEvent({
        type: 'status',
        text: `Goal turn ${turn}/${total}: thinking…`,
        goalTurn: turn,
        goalTotal: total,
      });
    },
    onTurnEnd: ({ turn, done, reason }) => {
      writeEvent({
        type: 'status',
        text: done
          ? `Judge: complete after turn ${turn} (${reason}).`
          : `Judge: not yet done after turn ${turn} (${reason}). Continuing…`,
        goalTurn: turn,
        goalJudgeDone: done,
      });
    },
    driveAssistant: async (message) => {
      // Each goal turn is a normal assistant.respond() call. The text
      // we get back is what we'll surface as a chat turn.
      const turnResponse = await assistant.respond({
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
        shouldCancel: () => shouldCancel(),
      });
      // Emit a turn-boundary marker so the dashboard can visually
      // separate goal turns in the same conversation thread.
      writeEvent({
        type: 'goal-turn-complete',
        text: turnResponse.text,
        pendingApprovalId: turnResponse.pendingApprovalId ?? null,
        stoppedReason: turnResponse.stoppedReason ?? 'success',
      });
      return { text: turnResponse.text };
    },
  });

  // Terminal event. The dashboard reads this to render the final
  // affordance — "achieved" / "paused → resume?" / "budget-limited" /
  // "unmet". Vocabulary mirrors OpenAI Codex CLI 0.128.0's /goal.
  const finalText = describeGoalState(result);
  writeEvent({
    type: 'done',
    text: finalText,
    stoppedReason: result.status === 'achieved' ? 'success'
      : result.status === 'paused' || result.status === 'budget-limited' ? 'max-turns-with-grace'
      : 'cancelled',
    turnsUsed: result.turnsUsed,
    goalStatus: result.status,
    goalObjective: result.objective,
  });
}

function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}

function sanitizeWorkflowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
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

interface WorkflowRunRecordSummary {
  id: string;
  workflow: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  error: string | null;
  targetStepId: string | null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeWorkflowRunRecord(raw: Record<string, unknown>): WorkflowRunRecordSummary | null {
  const id = stringField(raw.id);
  const workflow = stringField(raw.workflow);
  if (!id || !workflow) return null;
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
  };
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


export function registerConsoleRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
  assistant: ClementineAssistant,
): void {
  app.get('/console', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(renderConsoleHtml(queryToken));
  });

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
      const { findLatestReport, listReports } = await import('../autoresearch/observatory.js');
      const latest = findLatestReport();
      const history = listReports().slice(0, 30);
      res.json({ latest, history });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Autoresearch — force-regenerate the report NOW (the "Run autoresearch
   * now" button on the EVOLUTION panel). Returns the rebuilt content +
   * a written: true|false flag so the UI can say "no-op, content unchanged."
   */
  app.post('/api/console/autoresearch/run', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { buildReport, writeReport, renderReportMarkdown } = await import('../autoresearch/observatory.js');
      const report = buildReport();
      const result = writeReport(report);
      res.json({
        ...result,
        report,
        content: renderReportMarkdown(report),
      });
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
    if (typeof body.importance === 'number' && Number.isFinite(body.importance)) patch.importance = body.importance;
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
      res.json({
        facts: { active: facts, inactive: factsInactive, total: factsTotal, pinned },
        entities,
        episodicPointers: episodic,
        focusActive,
        embeddings: {
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
   * List indexed vault files with chunk counts + last index time. The
   * panel renders this as a browsable file tree on the left side.
   */
  /**
   * Build a {nodes, edges} graph payload for the Memory tab visualizer.
   *
   * Nodes:
   *   - fact     — durable knowledge entries
   *   - file     — indexed vault files (path-based)
   *   - kind     — fact kind clusters (user/project/feedback/reference)
   *
   * Edges:
   *   - fact → kind   (every fact connects to its kind cluster)
   *   - fact → file   (when the fact text mentions the file's name)
   *
   * Caps: 100 facts + 60 files by default to keep the layout snappy.
   */
  app.get('/api/console/memory/graph', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const factsLimit = Math.max(10, Math.min(300, parseInt(typeof req.query.facts === 'string' ? req.query.facts : '100', 10) || 100));
      const filesLimit = Math.max(10, Math.min(200, parseInt(typeof req.query.files === 'string' ? req.query.files : '60', 10) || 60));

      const facts = listActiveFacts({ limit: factsLimit });
      const db = openMemoryDb();
      const files = db.prepare(`
        SELECT path, MAX(mtime) AS mtime, COUNT(*) AS chunks
        FROM vault_chunks
        GROUP BY path
        ORDER BY MAX(mtime) DESC
        LIMIT ?
      `).all(filesLimit) as Array<{ path: string; mtime: number; chunks: number }>;

      const KIND_SET = new Set<string>();
      for (const f of facts) if (f.kind) KIND_SET.add(f.kind);
      const kinds = Array.from(KIND_SET);

      const nodes: Array<{ id: string; label: string; type: string; data?: Record<string, unknown> }> = [];
      const edges: Array<{ id: string; source: string; target: string; type: string }> = [];

      // Kind cluster nodes.
      for (const kind of kinds) {
        nodes.push({ id: `kind:${kind}`, label: kind.toUpperCase(), type: 'kind' });
      }

      // Fact nodes + fact→kind edges.
      const fileBasenames = files.map((f) => {
        const base = path.basename(f.path, path.extname(f.path));
        return { path: f.path, base, baseLower: base.toLowerCase() };
      });

      for (const fact of facts) {
        const id = `fact:${fact.id}`;
        const summary = (fact.content || '(fact)').trim().split('\n')[0].slice(0, 60);
        nodes.push({
          id,
          label: summary,
          type: 'fact',
          data: { kind: fact.kind, content: fact.content?.slice(0, 600), source: fact.source },
        });
        if (fact.kind) {
          edges.push({ id: `${id}->kind:${fact.kind}`, source: id, target: `kind:${fact.kind}`, type: 'kind' });
        }
        // Fact → file edges when the fact text mentions a file basename.
        const lower = (fact.content || '').toLowerCase();
        if (lower.length > 0) {
          for (const f of fileBasenames) {
            if (f.baseLower.length < 4) continue; // skip tiny names
            if (lower.includes(f.baseLower)) {
              edges.push({ id: `${id}->file:${f.path}`, source: id, target: `file:${f.path}`, type: 'mentions' });
            }
          }
        }
      }

      // File nodes — only include files that either have an inbound edge
      // OR are recently-active (top 30 by mtime).
      const referencedFilePaths = new Set(edges.filter((e) => e.target.startsWith('file:')).map((e) => e.target.slice(5)));
      const recentTop = files.slice(0, 30).map((f) => f.path);
      for (const path of recentTop) referencedFilePaths.add(path);

      for (const f of files) {
        if (!referencedFilePaths.has(f.path)) continue;
        nodes.push({
          id: `file:${f.path}`,
          label: f.path.split('/').slice(-2).join('/'),
          type: 'file',
          data: { chunks: f.chunks, mtime: f.mtime },
        });
      }

      // Entity nodes — the `entities` registry (people/companies/projects/
      // places/things). There is NO stored fact↔entity link, so edges are
      // DERIVED by matching an entity's canonical name / aliases (≥4 chars)
      // inside fact content — the same substring technique used for files.
      const entitiesLimit = Math.max(0, Math.min(150, parseInt(typeof req.query.entities === 'string' ? req.query.entities : '80', 10) || 80));
      if (entitiesLimit > 0) {
        const entityRows = db.prepare(`
          SELECT id, entity_type, canonical_name, canonical_name_lc, aliases_json, mention_count
          FROM entities
          ORDER BY mention_count DESC, last_seen_at DESC
          LIMIT ?
        `).all(entitiesLimit) as Array<{ id: number; entity_type: string; canonical_name: string; canonical_name_lc: string; aliases_json: string | null; mention_count: number }>;

        const entityMatchers = entityRows.map((e) => {
          const names = new Set<string>();
          if (e.canonical_name_lc && e.canonical_name_lc.length >= 4) names.add(e.canonical_name_lc);
          try {
            const aliases = e.aliases_json ? JSON.parse(e.aliases_json) : [];
            if (Array.isArray(aliases)) {
              for (const a of aliases) {
                const al = String(a || '').trim().toLowerCase();
                if (al.length >= 4) names.add(al);
              }
            }
          } catch { /* malformed aliases — skip */ }
          return { row: e, names: Array.from(names) };
        });

        const referencedEntityIds = new Set<number>();
        for (const fact of facts) {
          const lower = (fact.content || '').toLowerCase();
          if (!lower) continue;
          for (const m of entityMatchers) {
            if (m.names.some((n) => lower.includes(n))) {
              referencedEntityIds.add(m.row.id);
              edges.push({ id: `fact:${fact.id}->entity:${m.row.id}`, source: `fact:${fact.id}`, target: `entity:${m.row.id}`, type: 'entity' });
            }
          }
        }

        // Include an entity node if it linked to a fact OR is among the
        // top ~30 most-mentioned (so prominent entities still show).
        const topEntityIds = new Set(entityRows.slice(0, 30).map((e) => e.id));
        for (const e of entityRows) {
          if (!referencedEntityIds.has(e.id) && !topEntityIds.has(e.id)) continue;
          nodes.push({
            id: `entity:${e.id}`,
            label: e.canonical_name,
            type: 'entity',
            data: { entity_type: e.entity_type, mention_count: e.mention_count },
          });
        }
      }

      // Phase 4 — optional semantic 3D layout. ?layout=semantic projects
      // fact embeddings (1536-dim) → 3D via PCA and attaches fixed fx/fy/fz
      // to fact nodes so semantically-similar facts cluster in space.
      if (req.query.layout === 'semantic') {
        try {
          const positions = computeSemanticFactPositions(db, facts.map((f) => f.id));
          if (positions) {
            for (const node of nodes) {
              if (node.type !== 'fact') continue;
              const fid = Number(String(node.id).slice('fact:'.length));
              const p = positions.get(fid);
              if (p) {
                node.data = { ...(node.data || {}), fx: p[0], fy: p[1], fz: p[2] };
              }
            }
          }
        } catch { /* embeddings unavailable — fall back to force layout */ }
      }

      res.json({
        nodes,
        edges,
        meta: {
          factCount: facts.length,
          fileCount: nodes.filter((n) => n.type === 'file').length,
          kindCount: kinds.length,
          entityCount: nodes.filter((n) => n.type === 'entity').length,
          edgeCount: edges.length,
          semantic: req.query.layout === 'semantic',
        },
      });
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

  // ─── Workflow Studio ──────────────────────────────────────────

  app.get('/api/console/workflows', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const items = listWorkflows()
        .sort((a, b) => a.data.name.localeCompare(b.data.name))
        .map((entry) => ({
          name: entry.data.name,
          file: entry.layout === 'directory' ? `${entry.name}/SKILL.md` : `${entry.name}.md`,
          description: entry.data.description,
          enabled: entry.data.enabled,
          triggerSchedule: entry.data.trigger.schedule ?? null,
          stepCount: entry.data.steps.length,
          trigger: entry.data.trigger,
          steps: entry.data.steps,
          inputs: entry.data.inputs ?? {},
          synthesis: entry.data.synthesis ?? null,
          allowedTools: entry.data.allowedTools ?? null,
          whenToUse: entry.data.whenToUse ?? null,
        }));
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
        if (run.status !== 'queued' && run.status !== 'running') continue;
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
        return {
          name: entry.data.name,
          file: entry.layout === 'directory' ? `${entry.name}/SKILL.md` : `${entry.name}.md`,
          description: entry.data.description,
          enabled: entry.data.enabled,
          triggerSchedule: entry.data.trigger.schedule ?? null,
          stepCount: entry.data.steps.length,
          inputCount: Object.keys(entry.data.inputs ?? {}).length,
          hasSynthesis: !!entry.data.synthesis?.prompt,
          activeRun,
          lastRun: runs[0] ?? null,
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

  app.get('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    // Accept lookup either by display name (data.name) or by directory
    // slug. Most callers use the display name (round-tripped from the
    // workflows list), but the Architect agent may pass the slug.
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    res.json({
      name: entry.data.name,
      file: entry.layout === 'directory' ? `${entry.name}/SKILL.md` : `${entry.name}.md`,
      description: entry.data.description,
      enabled: entry.data.enabled,
      trigger: entry.data.trigger,
      steps: entry.data.steps,
      inputs: entry.data.inputs ?? {},
      synthesis: entry.data.synthesis ?? null,
      allowedTools: entry.data.allowedTools ?? null,
      whenToUse: entry.data.whenToUse ?? null,
    });
  });

  app.post('/api/console/workflows', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    const slug = sanitizeWorkflowName(name);
    if (readWorkflow(slug)) { res.status(409).json({ error: 'workflow already exists' }); return; }
    const description = typeof body.description === 'string' ? body.description : '';
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const triggerSchedule = typeof body.triggerSchedule === 'string' ? body.triggerSchedule.trim() : '';
    const trigger = triggerSchedule ? { schedule: triggerSchedule, manual: true } : { manual: true };
    if (triggerSchedule && !validateCronExpression(triggerSchedule)) {
      res.status(400).json({ error: `invalid cron expression: "${triggerSchedule}"` }); return;
    }
    const synthesis = typeof body.synthesisPrompt === 'string' && body.synthesisPrompt.trim()
      ? { prompt: body.synthesisPrompt.trim() } : undefined;
    const inputs = (body.inputs && typeof body.inputs === 'object') ? body.inputs : undefined;

    const def: WorkflowDefinition = {
      name,
      description,
      enabled: body.enabled !== false,
      trigger,
      steps,
      inputs: inputs && Object.keys(inputs).length > 0 ? inputs : undefined,
      synthesis,
    };
    writeWorkflow(slug, def);
    res.json({ created: true, name, file: `${slug}/SKILL.md` });
  });

  app.patch('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    const next: WorkflowDefinition = { ...entry.data };

    if (typeof body.description === 'string') next.description = body.description;
    if (Array.isArray(body.steps)) next.steps = body.steps;
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (body.synthesisPrompt !== undefined) {
      next.synthesis = typeof body.synthesisPrompt === 'string' && body.synthesisPrompt.trim()
        ? { prompt: body.synthesisPrompt.trim() } : undefined;
    }
    if (body.inputs && typeof body.inputs === 'object') next.inputs = body.inputs;
    if (typeof body.triggerSchedule === 'string') {
      const s = body.triggerSchedule.trim();
      if (s && !validateCronExpression(s)) { res.status(400).json({ error: `invalid cron: ${s}` }); return; }
      next.trigger = s ? { schedule: s, manual: true } : { manual: true };
    } else if (body.clearTriggerSchedule === true) {
      next.trigger = { manual: true };
    }

    writeWorkflow(entry.name, next);
    res.json({ updated: true, name: next.name });
  });

  app.delete('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    deleteWorkflow(entry.name);
    res.json({ deleted: true });
  });

  app.post('/api/console/workflows/:name/set-enabled', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) required' }); return; }
    // P2: a workflow whose data can't flow can't be ENABLED (disabling
    // always allowed). Flag-gated → no-op when WORKFLOW_TYPED_CONTRACT off.
    if (body.enabled) {
      const check = checkWorkflowForWrite({ ...entry.data, enabled: true });
      if (!check.ok) {
        res.status(400).json({ error: 'workflow failed validation', errors: check.errors });
        return;
      }
    }
    writeWorkflow(entry.name, { ...entry.data, enabled: body.enabled });
    res.json({ updated: true, enabled: body.enabled });
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
      steps: entry.data.steps,
      inputs: entry.data.inputs,
      synthesis: entry.data.synthesis,
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

    ensureDir(WORKFLOW_RUNS_DIR);
    const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
    const payload: Record<string, unknown> = {
      id,
      workflow: entry.data.name,
      inputs,
      status: dryRun ? 'dry_run' : 'queued',
      createdAt: new Date().toISOString(),
      source: 'console',
    };
    if (targetStepId) payload.targetStepId = targetStepId;
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    res.json({ queued: !dryRun, dryRun, id, targetStepId });
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
      'Each workflow has: name, description, trigger (manual or cron schedule), steps (id + prompt + optional dependsOn + optional allowed_tools + optional uses_skill), inputs, optional synthesis prompt.',
      'Be terse. No preamble. Lead with the answer. One short paragraph of prose at most.',
      '',
      'IMPORTANT — proposing changes:',
      '• Do NOT call workflow_create or any workflow_* tool. The user will apply your proposed changes from the UI.',
      '• If you are proposing ANY change to the draft, your reply MUST end with a single fenced ```json code block containing an object with shape { ops: [...], summary: "..." }.',
      '• Each op is one of:',
      '    { "type": "set_field",    "path": "name" | "description" | "triggerSchedule" | "enabled", "value": <value> }',
      '    { "type": "add_step",     "step": { "id": "<id>", "prompt": "<text>", "dependsOn": ["<id>", ...], "allowed_tools": ["<tool>", ...], "uses_skill"?: "<skill-name>" } }',
      '    { "type": "update_step",  "id": "<existing-id>", "patch": { "prompt"?: "...", "dependsOn"?: [...], "allowed_tools"?: [...], "uses_skill"?: "<skill-name> | null" } }',
      '    { "type": "remove_step",  "id": "<existing-id>" }',
      '    { "type": "reorder_step", "id": "<existing-id>", "after": "<other-id> | null (null = move to first)" }',
      '    { "type": "rename_step",  "id": "<existing-id>", "newId": "<new-id>" }',
      '    { "type": "add_input",    "key": "<key>", "value": "<default-or-empty>" }',
      '    { "type": "remove_input", "key": "<key>" }',
      '    { "type": "set_synthesis","value": "<prompt-text> | null (null clears it)" }',
      '• Keep ops minimal. Use update_step (with only the fields you actually change) instead of remove + add.',
      '• When proposing a step that calls a tool, populate allowed_tools with the minimum set needed (e.g. ["composio_gmail_send_email"]).',
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
      const response = await assistant.respond({
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
      });
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

  app.get('/api/console/settings', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const profile = loadUserProfile();
      const proactivity = getProactivityPolicySnapshot();
      const auth = getAuthStatus();
      const memory = readMemoryIndexStatus();
      const models = getModelSettingsSnapshot();
      const runtimeBudget = getHarnessBudgetSnapshot();
      res.json({ profile, proactivity, auth, memory, models, runtimeBudget });
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
      const activeNonChatSessions = listHarnessSessions({
        kind: ['workflow', 'execution', 'agent'],
        status: ['active', 'paused'],
        limit: 100,
      });
      const pendingApprovals = approvalRegistry.listPending({ status: 'pending' });
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
    const eventsDir = path.join(os.homedir(), '.clementine-next', 'state', 'tool-events');
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
      res.json({ rows, descriptors, auth: getAuthStatus() });
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
    const result = approvePlanAndQueueBackgroundTask(req.params.id, { editedPlan, scopeTtlMs, allowedTools });
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
      res.json({ servers: discovered, userOverrides: user });
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
   * v0.5.11 — Brain panel endpoints. Read-only views of what the brain
   * has learned (facts, entities, pointers, health stats). All
   * sourced from the memory.db tables introduced in v0.5.11 migration
   * v3 + v4 (see [[project_brain_architecture]] + [[project_brain_phase1_gaps]]).
   */
  app.get('/api/console/brain/facts', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { listActiveFacts, countActiveFacts } = await import('../memory/facts.js');
      const kindParam = typeof req.query.kind === 'string' ? req.query.kind : '';
      const sort = typeof req.query.sort === 'string' ? req.query.sort : 'stanford';
      const allowedKinds = new Set(['user', 'project', 'feedback', 'reference']);
      const kind = allowedKinds.has(kindParam) ? (kindParam as 'user' | 'project' | 'feedback' | 'reference') : undefined;
      const limit = 100;
      let facts = listActiveFacts({ limit, kind, ranking: sort === 'stanford' ? 'stanford' : 'score' });
      if (sort === 'recent') {
        facts = [...facts].sort((a, b) =>
          (b.lastAccessedAt || b.updatedAt || '').localeCompare(a.lastAccessedAt || a.updatedAt || ''),
        );
      } else if (sort === 'important') {
        facts = [...facts].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
      } else if (sort === 'trust') {
        facts = [...facts].sort((a, b) => (b.trustLevel ?? 0) - (a.trustLevel ?? 0));
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
        // We emitted reflection lifecycle via recordToolEvent — those
        // land in ~/.clementine-next/state/tool-events/<date>.ndjson,
        // not harness.db. Reading those files directly here.
        const path = await import('node:path');
        const fs = await import('node:fs');
        const dir = path.join(require('node:os').homedir(), '.clementine-next', 'state', 'tool-events');
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

  app.get('/api/console/background-tasks/:id', (req, res) => {
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
      res.json({ task: { ...task, resultFull }, detail });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
    const shouldResume = !!harnessSession?.loadInterruptState();
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
        status: 'resolved-stale',
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
        return task.status === 'pending' || task.status === 'running' || task.status === 'interrupted';
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
        })),
        ...checkInProposals.map((proposal) => ({
          kind: 'proposal',
          title: proposal.name || proposal.description || proposal.id,
          meta: 'check-in proposal',
          panel: 'settings',
          urgency: 'normal',
        })),
        ...openCheckIns.map((checkIn) => ({
          kind: 'checkin',
          title: checkIn.question || '(check-in)',
          meta: checkIn.urgency !== 'normal' ? `${checkIn.urgency} · ${checkIn.askedAt.slice(11, 16)}` : `asked ${checkIn.askedAt.slice(11, 16)}`,
          panel: 'settings',
          urgency: checkIn.urgency === 'high' ? 'high' : 'normal',
        })),
        ...activeBackgroundTasks.filter((task) => task.status === 'awaiting_approval' && !task.pendingApprovalId).map((task) => ({
          kind: 'background',
          title: task.title,
          meta: task.id,
          panel: 'approvals',
          urgency: 'high',
        })),
      ].map((item) => ({ ...item, title: trimConsoleTitle(item.title, 140) }));

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
          return {
            kind: task.status === 'pending' ? 'queued' : task.status,
            title: task.status === 'awaiting_approval'
              ? `Waiting for approval: ${summary}`
              : task.title,
            meta: task.lastCheckInMessage
              ? `${task.id} · ${task.lastCheckInMessage}`
              : `${task.id} · ${task.status}`,
            panel: task.status === 'awaiting_approval' ? 'approvals' : 'activity',
            approvalKind: runtimeApproval ? 'runtime' : undefined,
            approvalId: runtimeApproval?.id,
          };
        }),
        ...pendingWorkflowRuns.map((run) => {
          const workflow = readWorkflow(run.workflowName);
          const title = workflow?.data?.name ?? run.workflowName;
          return {
            kind: 'workflow',
            title: run.inFlightStepId ? `${title} · ${run.inFlightStepId}` : title,
            meta: `run ${run.runId}${run.lastEventAt ? ` · ${run.lastEventAt.slice(11, 16)}` : ''}`,
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
          title: task.title,
          meta: task.result
            ? trimConsoleTitle(task.result.replace(/^#+\s*/gm, '').split('\n').find((line) => line.trim() && !line.includes('/Users/')) || task.result, 120)
            : task.completedAt ? `done ${task.completedAt.slice(11, 16)}` : task.id,
          panel: 'activity',
          actionKind: 'background-task',
          taskId: task.id,
        })),
        ...runs.filter((run) => run.status === 'completed').slice(0, 5).map((run) => ({
          kind: 'done',
          title: run.title || run.input || run.id,
          meta: run.completedAt ? `done ${run.completedAt.slice(11, 16)}` : run.id,
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
      const waitingCount = needsYou.length;
      const currentObjective = workingNow[0]?.title
        ?? needsYou[0]?.title
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
        needsYou,
        workingNow,
        recentCompleted,
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
    if (!input) { res.status(400).json({ error: 'input required' }); return; }

    const existingId = typeof body.sessionId === 'string' ? body.sessionId : '';
    let session = existingId ? getHarnessSession(existingId) : null;
    const freshSession = !session;
    if (existingId && !session) { res.status(404).json({ error: 'session not found' }); return; }
    if (!session) {
      session = createHarnessSession({
        kind: 'chat',
        title: input.length > 80 ? `${input.slice(0, 77)}...` : input,
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
    // an awaiting_continue (limit-exceeded). Falls through to the
    // normal turn path with the rewritten input.
    let turnInput = input;
    if (command === 'continue') {
      const { readLastConversationCompletion } = await import('../channels/discord-harness.js');
      const lastCompletion = readLastConversationCompletion(sessionId);
      if (lastCompletion?.reason === 'awaiting_continue') {
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

    // If this session is paused on an SDK approval interrupt and the
    // user's message is an approve/reject intent, take the RESUME path
    // instead of starting a new turn. Mirrors the Discord-side
    // tryHandleHarnessApprovalReply pattern — without this, the chat
    // dock had no way to resume a paused session, the SEND button sat
    // in THINKING forever, and the user couldn't continue the workflow.
    const harnessSession = HarnessSession.load(sessionId);
    const isPausedOnApproval = !!harnessSession && !!harnessSession.loadInterruptState();
    const intent = isPausedOnApproval ? parseApprovalIntent(input) : null;
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
        if (planFirst) {
          const preflight = await runPlanFirstPreflight({
            input: turnInput,
            sessionId,
            channel: 'desktop',
            freshSession,
            autonomy,
          });
          if (preflight.surfaced) return;
        }
        const agent = await buildOrchestratorAgent({ userInput: turnInput, sessionId });
        if (intent && harnessSession) {
          await runConversationFromResume({
            agent,
            sessionId,
            decision: intent.decision,
            resolver: 'chat-dock-user',
          });
          return;
        }
        await runConversation({ agent, sessionId, input: turnInput, judgeCompletion: true });
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
      // /goal slash-command interception. We do this BEFORE the normal
      // respond() so the loop driver controls turn pacing + judging.
      const goalCmd = parseGoalCommand(message);
      if (goalCmd) {
        await handleGoalCommand({
          command: goalCmd,
          sessionId: 'console:home',
          assistant,
          writeEvent,
          shouldCancel: () => closed,
        });
        res.end();
        return;
      }

      writeEvent({ type: 'status', text: 'Clementine run started.' });
      const response = await assistant.respond({
        message,
        sessionId: 'console:home',
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
        onReasoning: () => {
          writeEvent({ type: 'status', text: 'Clementine is planning the next step.' });
        },
        shouldCancel: () => closed,
      });
      writeEvent({
        type: 'done',
        text: response.text,
        pendingApprovalId: response.pendingApprovalId ?? null,
        // Surface why the run stopped so the dashboard can render the
        // right affordance ([Continue] for max-turns-with-grace, etc.).
        stoppedReason: response.stoppedReason ?? 'success',
        turnsUsed: response.turnsUsed ?? null,
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
      // Lazy-import to avoid pulling goal-loop into the top of this
      // file just for one route; keeps the existing import graph stable.
      const { loadGoalState } = await import('../agents/goal-loop.js');
      const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
        ? req.query.sessionId.trim().slice(0, 120)
        : 'console:home';
      const state = loadGoalState(sessionId);
      res.json({ goal: state });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/home/chat', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) { res.status(400).json({ error: 'message required' }); return; }
    try {
      const response = await assistant.respond({
        message,
        sessionId: 'console:home',
        channel: 'cli',
        userId: 'console',
      });
      res.json({ text: response.text, pendingApprovalId: response.pendingApprovalId });
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
    const instructions = buildRealtimeVoiceInstructions(sessionId);

    const session = {
      session: {
        type: 'realtime',
        model,
        instructions,
        audio: {
          input: {
            transcription: { model: transcriptionModel },
            turn_detection: {
              type: 'server_vad',
              threshold: realtimeNumberEnv('OPENAI_REALTIME_VAD_THRESHOLD', 0.55, 0.1, 0.95),
              prefix_padding_ms: realtimeNumberEnv('OPENAI_REALTIME_PREFIX_PADDING_MS', 350, 0, 1500),
              silence_duration_ms: realtimeNumberEnv('OPENAI_REALTIME_SILENCE_MS', 430, 150, 2000),
              idle_timeout_ms: realtimeNumberEnv('OPENAI_REALTIME_IDLE_TIMEOUT_MS', 6500, 1000, 30000),
              interrupt_response: true,
              create_response: true,
            },
          },
          output: { voice },
        },
        tools: [
          {
            type: 'function',
            name: 'send_to_clementine',
            description: 'Send a spoken user request to the local Clementine agent for tool use, local computer actions, project work, approvals, or long-running execution.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                request: {
                  type: 'string',
                  description: 'The exact user request to send to Clementine.',
                },
                reason: {
                  type: 'string',
                  description: 'Why this request should be handled by the local agent instead of only the realtime voice model.',
                },
              },
              required: ['request', 'reason'],
            },
          },
        ],
        tool_choice: 'auto',
      },
      expires_after: {
        anchor: 'created_at',
        seconds: 600,
      },
    };

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
