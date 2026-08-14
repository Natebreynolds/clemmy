import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { registerMemoryTools } from './memory-tools.js';
import { registerFocusTools } from './focus-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { registerPlanTools } from './plan-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerDynamicTools } from './dynamic-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerAdminTools } from './admin-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerOrchestrationTools } from './orchestration-tools.js';
import { registerPendingActionTools } from './pending-action-tools.js';
import { registerAgentRunsTools } from './agent-runs-tools.js';
import { registerAutonomyActionTools } from './autonomy-action-tools.js';
import { registerBackgroundTaskTools } from './background-task-tools.js';
import { registerWorkerTools } from './worker-tools.js';
import { registerWorkflowStateTools } from './workflow-state-tools.js';
import { registerTableOpsTools } from './table-ops-tools.js';
import { registerDocumentProduceTools } from './document-produce-tools.js';
import { registerFileQueryTools } from './file-query-tools.js';
import { registerTimeSlotsTools } from './time-slots-tools.js';
import { registerExtractStructuredTools } from './extract-structured-tools.js';
import { registerBatchTools } from './batch-tools.js';
import { registerExecutionTools } from './execution-tools.js';
import { registerProfileTools } from './profile-tools.js';
import { registerCapabilityTools } from './capability-tools.js';
import { registerHarnessStatusTools } from './harness-status-tools.js';
import { registerCliTools } from './cli-tools.js';
import { registerCliSetupTools } from './cli-setup-tools.js';
import { registerProjectRunTools } from './project-run-tools.js';
import { registerSkillTools } from './skill-tools.js';
import { registerWorkflowScheduleTools } from './workflow-schedule-tools.js';
import { registerSpaceTools } from './space-tools.js';
import { registerMcpStatusTools } from './mcp-status-tools.js';
import { registerMcpServerTools } from './mcp-server-tools.js';
import { registerToolChoiceTools } from './tool-choice-tools.js';
import { registerModelRoleTools } from './model-role-tools.js';
import { registerRecallTools } from './recall-tools.js';
import { registerArtifactClaimTools } from './artifact-claim-tools.js';
import { registerWorkspaceArtifactTools } from './workspace-artifact-tools.js';
import { registerToolSearchTool } from './tool-search-tool.js';
import { buildAuthorizedToolSearchCandidateSources } from './tool-search-provider-sources.js';
import {
  registerCallToolMcp,
  type BuiltinCapabilityAdmissionResult,
} from './call-tool.js';
import { registerClaudeActionWorkCall } from './work-call-mcp.js';
import { registerGatedMutatingTools } from './gated-mutating-tools.js';
import { codeModeEnabled, codeModeDescription, runCodeModeForSession } from './code-mode-tool.js';
import { ensureToolDirectories, textResult } from './shared.js';
import { loadPlugins } from '../plugins/loader.js';
import type { PluginTool } from '../plugins/types.js';
import { withToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { withHarnessRunContext, ToolCallsCounter } from '../runtime/harness/brackets.js';
import {
  mcpToolScopeAuthority,
  type McpToolScope,
} from '../runtime/mcp-tool-scope.js';
import {
  assertDispatchLeaseCurrent,
  parseDispatchLease,
  type DispatchLeaseRef,
} from '../runtime/harness/dispatch-lease.js';
import type { SealableToolLike } from '../agents/capability-envelope.js';
import type { AdmissionEnvelope, CapabilityBindingRevision } from '../runtime/graph/admission-envelope.js';

// Counter cap for the ambient harness run context. Most tools wrapped here are
// reads that never touch the counter; the gated mutating tools set their OWN
// inner context (gated-mutating-tools.ts), so this ambient counter only ever
// matters as a benign fallback.
const AMBIENT_COUNTER_LIMIT = 1000;

function resolvedMcpToolScope(
  opts: ClementineMcpServerOptions,
): McpToolScope | null | undefined {
  if (opts.mcpToolScope !== undefined) return opts.mcpToolScope;
  const raw = process.env.CLEMENTINE_MCP_TOOL_SCOPE_JSON;
  if (!raw) return undefined;
  try { return JSON.parse(raw) as McpToolScope | null; } catch { return undefined; }
}

export interface ClementineMcpServerOptions {
  sessionId?: string;
  runScopeId?: string;
  /** Explicit foreground-orchestrator eligibility for one-shot read recovery.
   * Workers/workflow steps pass false; absence remains legacy/non-SDK. */
  directOrchestrator?: boolean;
  /** Explicit run_worker child identity. Unlike directOrchestrator=false this
   * does not include workflow steps or other non-foreground lanes. */
  workerScope?: boolean;
  /** Exact accepted user event owned by this SDK attempt. The in-process and
   * stdio MCP transports must carry the same authority into nested carriers. */
  sourceUserSeq?: number;
  /** Exact parent external-MCP authority carried through the Claude SDK's
   * in-process or stdio local-MCP transport into nested tools/workers. */
  mcpToolScope?: McpToolScope | null;
  /** Physical SDK attempt allowed to enter local tool handlers. Serialized
   * through env when this server runs as a stdio child. */
  dispatchLease?: DispatchLeaseRef;
  gatedMutations?: boolean;
  /** Trusted transport request to expose the action-only semantic carrier.
   * Registration still revalidates the exact persisted task as activated act. */
  actionExpectedWork?: boolean;
  allowedTools?: string[];
  /** Tools that must remain first-class when the client supports MCP tool
   * deferral. Every unmarked registered tool remains available for native
   * same-turn ToolSearch acquisition. */
  alwaysLoadTools?: string[];
  /** Tools deliberately omitted from this server's advertised schema surface
   * but still reachable this turn through tool_search → call_tool. */
  deferredTools?: string[];
  /** Set for a workflow-step MCP surface so a fan-out spawned here (run_worker) is
   *  attributed to the workflow RUN in the subagent-runs store, not just the session. */
  workflowRunId?: string;
  workflowName?: string;
  stepId?: string;
  /** Internal surface introspection. Called only for tools this server actually
   * registers after feature gates and allowlists have been evaluated. */
  onToolRegistered?: (name: string) => void;
}

type McpCapabilityController = {
  authority: object;
  initialize(): Promise<boolean>;
  admit(name: string): Promise<BuiltinCapabilityAdmissionResult>;
  errors(): readonly string[];
};

const MCP_CAPABILITY_CONTROLLERS = new WeakMap<McpServer, McpCapabilityController>();
let coreCapabilityDescriptorsPromise: Promise<Map<string, SealableToolLike>> | null = null;

function registrationDescriptor(args: readonly unknown[]): SealableToolLike | null {
  const name = typeof args[0] === 'string' ? args[0].trim() : '';
  if (!name) return null;
  const description = typeof args[1] === 'string' ? args[1] : '';
  const schemaInput = typeof args[1] === 'string' ? args[2] : args[1];
  let parameters: unknown = null;
  if (schemaInput && typeof schemaInput === 'object') {
    try {
      const candidate = schemaInput as z.ZodTypeAny & Record<string, unknown>;
      parameters = ('_zod' in candidate || '_def' in candidate)
        ? z.toJSONSchema(candidate)
        : z.toJSONSchema(z.object(schemaInput as z.ZodRawShape));
    } catch {
      // Some valid MCP raw shapes (notably run_worker) contain Zod constructs
      // that the public z.toJSONSchema converter rejects even though the MCP
      // SDK's compatibility converter accepts and registers them. Preserve the
      // exact source shape for fingerprinting instead of erasing the descriptor:
      // capability-envelope already fingerprints Zod parameters in this form on
      // the OpenAI lane. A genuinely absent/non-object schema remains null and
      // still falls back to the core dispatcher descriptor below.
      parameters = schemaInput;
    }
  }
  return { name, description, parameters };
}

async function coreCapabilityDescriptors(): Promise<Map<string, SealableToolLike>> {
  if (!coreCapabilityDescriptorsPromise) {
    coreCapabilityDescriptorsPromise = import('./registry.js')
      .then(({ getCoreTools }) => {
        const descriptors = new Map<string, SealableToolLike>();
        for (const tool of getCoreTools() as unknown as SealableToolLike[]) {
          const name = typeof tool.name === 'string' ? tool.name.trim() : '';
          if (name) descriptors.set(name, tool);
        }
        return descriptors;
      });
  }
  return coreCapabilityDescriptorsPromise;
}

function createMcpCapabilityController(input: {
  opts: ClementineMcpServerOptions;
  registeredNames: ReadonlySet<string>;
  deferredNames: ReadonlySet<string>;
  consideredDescriptors: ReadonlyMap<string, SealableToolLike>;
}): McpCapabilityController {
  const authority = {};
  let initialization: Promise<boolean> | null = null;
  let sealErrors: string[] = [];

  const initialize = (): Promise<boolean> => {
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const [core, capability, budgetModule, policyModule] = await Promise.all([
          coreCapabilityDescriptors(),
          import('../agents/capability-envelope.js'),
          import('../runtime/harness/budget-settings.js'),
          import('../agents/proactivity-policy.js'),
        ]);
        const universeNames = new Set([...input.registeredNames, ...input.deferredNames]);
        const universeTools: SealableToolLike[] = [];
        const missing: string[] = [];
        for (const name of universeNames) {
          // Prefer the exact descriptor this MCP server attempted to register;
          // local-runtime-only deferred tools have no MCP adapter and fall
          // back to the same core Tool object call_tool will dispatch.
          const considered = input.consideredDescriptors.get(name);
          const descriptor = considered && considered.parameters !== null ? considered : core.get(name);
          if (descriptor) universeTools.push(descriptor);
          else missing.push(`${name}${considered ? ' (captured without parameters)' : ' (registration not observed)'}`);
        }
        if (missing.length > 0) {
          sealErrors = [`capability descriptors are missing for: ${missing.sort().join(', ')}`];
          return false;
        }
        const budgetSettings = budgetModule.getHarnessBudgetSettings();
        const dispatchLease = input.opts.dispatchLease
          ?? parseDispatchLease(process.env.CLEMENTINE_MCP_DISPATCH_LEASE_JSON);
        const sealed = capability.sealAgentCapabilityUniverse({
          sessionId: dispatchLease?.scopeId
            ?? input.opts.runScopeId
            ?? input.opts.sessionId
            ?? process.env.CLEMENTINE_MCP_RUN_SCOPE_ID
            ?? process.env.CLEMENTINE_MCP_SESSION_ID
            ?? 'unbound-mcp-run',
          universeTools,
          activeToolNames: [...input.registeredNames],
          policyHash: createHash('sha256')
            .update(JSON.stringify(policyModule.getProactivityPolicySnapshot().policy), 'utf-8')
            .digest('hex'),
          budget: {
            maxUncachedTokens: budgetSettings.maxRunTokens > 0 ? budgetSettings.maxRunTokens : 10_000_000,
            maxModelCalls: budgetSettings.maxTurns > 0 ? budgetSettings.maxTurns * 4 : 200,
            maxToolCalls: budgetSettings.toolCallsPerTurn > 0
              ? budgetSettings.toolCallsPerTurn * (budgetSettings.maxTurns > 0 ? budgetSettings.maxTurns : 50)
              : 500,
            maxElapsedMs: budgetSettings.maxConversationWallMs > 0
              ? budgetSettings.maxConversationWallMs
              : 3_600_000,
          },
        });
        if (!sealed.ok) {
          sealErrors = [...sealed.errors];
          return false;
        }
        capability.bindAgentCapabilityEnvelope(authority, sealed.envelope);
        capability.bindAgentCapabilityRevision(authority, sealed.revision);
        sealErrors = [];
        return true;
      } catch (error) {
        sealErrors = [error instanceof Error ? error.message : String(error)];
        return false;
      }
    })();
    return initialization;
  };

  return {
    authority,
    initialize,
    async admit(name) {
      if (!await initialize()) {
        return {
          ok: false,
          kind: 'requires_readmission',
          outside: [name],
          reason: `the MCP capability universe could not seal: ${sealErrors.join('; ') || 'unknown refusal'}`,
        };
      }
      const capability = await import('../agents/capability-envelope.js');
      return capability.appendAgentCapabilityBinding(authority, name);
    },
    errors: () => sealErrors,
  };
}

/** Initialize/query the per-physical-server capability authority. A server
 * without a deferred acquisition door intentionally has no controller. */
export async function initializeClementineMcpCapabilityAuthority(server: McpServer): Promise<boolean> {
  const controller = MCP_CAPABILITY_CONTROLLERS.get(server);
  return controller ? controller.initialize() : true;
}

export async function boundClementineMcpCapabilityEnvelope(
  server: McpServer,
): Promise<AdmissionEnvelope | null> {
  const controller = MCP_CAPABILITY_CONTROLLERS.get(server);
  if (!controller) return null;
  const capability = await import('../agents/capability-envelope.js');
  return capability.boundAgentCapabilityEnvelope(controller.authority);
}

export async function boundClementineMcpCapabilityRevision(
  server: McpServer,
): Promise<CapabilityBindingRevision | null> {
  const controller = MCP_CAPABILITY_CONTROLLERS.get(server);
  if (!controller) return null;
  const capability = await import('../agents/capability-envelope.js');
  return capability.boundAgentCapabilityRevision(controller.authority);
}

function installAmbientToolContext(server: McpServer, opts: ClementineMcpServerOptions = {}): void {
  const sessionId = opts.sessionId?.trim() || process.env.CLEMENTINE_MCP_SESSION_ID?.trim();
  if (!sessionId) return;
  // Workflow attribution flows via opts (in-process server) OR env (stdio child) —
  // mirrors how sessionId reaches here, so run_worker's context carries the run.
  const workflowRunId = opts.workflowRunId?.trim() || process.env.CLEMENTINE_MCP_WORKFLOW_RUN_ID?.trim() || undefined;
  const workflowName = opts.workflowName?.trim() || process.env.CLEMENTINE_MCP_WORKFLOW_NAME?.trim() || undefined;
  const stepId = opts.stepId?.trim() || process.env.CLEMENTINE_MCP_STEP_ID?.trim() || undefined;
  const runScopeId = opts.runScopeId?.trim() || process.env.CLEMENTINE_MCP_RUN_SCOPE_ID?.trim() || undefined;
  const sourceUserSeq = (() => {
    if (Number.isSafeInteger(opts.sourceUserSeq) && (opts.sourceUserSeq ?? 0) > 0) return opts.sourceUserSeq;
    const value = Number.parseInt(process.env.CLEMENTINE_MCP_SOURCE_USER_SEQ ?? '', 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  })();
  const mcpToolScope = resolvedMcpToolScope(opts);
  const dispatchLease = opts.dispatchLease
    ?? parseDispatchLease(process.env.CLEMENTINE_MCP_DISPATCH_LEASE_JSON);
  const directOrchestrator = opts.directOrchestrator
    ?? (process.env.CLEMENTINE_MCP_DIRECT_ORCHESTRATOR ?? '').trim().toLowerCase() === 'on';
  const workerScope = opts.workerScope
    ?? (process.env.CLEMENTINE_MCP_WORKER_SCOPE ?? '').trim().toLowerCase() === 'on';
  const originalTool = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { tool: (...args: any[]) => unknown }).tool = (...args: any[]) => {
    const toolName = typeof args[0] === 'string' ? args[0] : undefined;
    const last = args.length - 1;
    const handler = args[last];
    if (toolName && typeof handler === 'function') {
      args[last] = async (...handlerArgs: any[]) => {
        // Reject before tool-output context, counters, audit mirrors, or the
        // handler itself can observe a superseded SDK query.
        assertDispatchLeaseCurrent(dispatchLease);
        return withToolOutputContext(
          {
            sessionId,
            ...(sourceUserSeq ? { sourceUserSeq } : {}),
            runScopeId,
            toolName,
            ...(workflowRunId ? { workflowRunId } : {}),
            ...(workflowName ? { workflowName } : {}),
            ...(stepId ? { stepId } : {}),
          },
          // Also establish the harness run context so tools that read it for the
          // active session (execution_create / execution_* / plan / goal, etc.)
          // resolve CLEMENTINE_MCP_SESSION_ID instead of failing with "requires a
          // harness session context". Without this, the Agent SDK lane deadlocks:
          // the execution-wrap gate demands an execution lane before an outbound
          // send, but execution_create could not see the session to open one.
          // The gated mutating tools nest their own inner context (with the real
          // per-call counter), so this is a safe outer fallback for everything else.
          () => withHarnessRunContext(
            {
              sessionId,
              behaviorScopeId: runScopeId,
              directOrchestrator,
              workerScope,
              counter: new ToolCallsCounter(AMBIENT_COUNTER_LIMIT),
              ...(sourceUserSeq ? { sourceUserSeq } : {}),
              ...(mcpToolScope !== undefined ? { mcpToolScope } : {}),
              ...(dispatchLease ? {
                dispatchLease,
                runAttemptId: dispatchLease.runAttemptId,
              } : {}),
            },
            () => handler(...handlerArgs),
          ),
        );
      };
    }
    return originalTool(...args);
  };
}

// JIT tool-RAG for the Claude Agent SDK lane (Phase 1, Claude-brain port). When the
// brain decides to JIT-reduce the per-turn tool surface, it spawns THIS server with
// CLEMENTINE_MCP_ALLOWED_TOOLS=<comma-list> so only those tools are ADVERTISED — and
// since the SDK sends the schema of every advertised tool to the model, fewer
// advertised tools = fewer input tokens (allowedTools/canUseTool gate calls but do
// NOT shrink the schema payload — verified against the SDK). Unset (default) → no
// filtering, every tool registers exactly as before (byte-identical). Installed
// AFTER the ambient-context wrap so it's the OUTERMOST check (skips before wrapping).
function resolvedToolAllowlist(opts: ClementineMcpServerOptions = {}): string[] {
  const fromOptions = opts.allowedTools?.map((s) => s.trim()).filter(Boolean);
  const raw = process.env.CLEMENTINE_MCP_ALLOWED_TOOLS?.trim();
  return fromOptions && fromOptions.length > 0
    ? fromOptions
    : raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
}

function resolvedAlwaysLoadTools(opts: ClementineMcpServerOptions = {}): string[] {
  const fromOptions = opts.alwaysLoadTools?.map((s) => s.trim()).filter(Boolean);
  const raw = process.env.CLEMENTINE_MCP_ALWAYS_LOAD_TOOLS?.trim();
  return fromOptions && fromOptions.length > 0
    ? fromOptions
    : raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
}

function resolvedDeferredTools(opts: ClementineMcpServerOptions = {}): string[] {
  const fromOptions = opts.deferredTools?.map((s) => s.trim()).filter(Boolean);
  const raw = process.env.CLEMENTINE_MCP_DEFERRED_TOOLS?.trim();
  return fromOptions && fromOptions.length > 0
    ? fromOptions
    : raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
}

function installToolAllowlistFilter(
  server: McpServer,
  opts: ClementineMcpServerOptions = {},
  onConsidered?: (descriptor: SealableToolLike) => void,
): void {
  const allowlist = resolvedToolAllowlist(opts);
  if (allowlist.length === 0 && !onConsidered) return;
  const allowed = new Set(allowlist);
  const filtering = allowed.size > 0;
  // Floor: a health tool that must always exist so the surface is never empty.
  const FLOOR = new Set(['ping']);
  const wrapped = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { tool: (...args: any[]) => unknown }).tool = (...args: any[]) => {
    if (onConsidered) {
      const descriptor = registrationDescriptor(args);
      if (descriptor) onConsidered(descriptor);
    }
    const toolName = typeof args[0] === 'string' ? args[0] : undefined;
    if (filtering && toolName && !allowed.has(toolName) && !FLOOR.has(toolName)) {
      return undefined; // not in the JIT set → don't advertise it (schema not sent)
    }
    return wrapped(...args);
  };
}

function installToolRegistrationObserver(
  server: McpServer,
  observer?: (name: string, descriptor: SealableToolLike | null) => void,
): void {
  if (!observer) return;
  const wrapped = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { tool: (...args: any[]) => unknown }).tool = (...args: any[]) => {
    const result = wrapped(...args);
    if (result !== undefined && typeof args[0] === 'string') {
      observer(args[0], registrationDescriptor(args));
    }
    return result;
  };
}

/** Mark only the recovery/hot subset as first-class for Claude's native MCP
 * ToolSearch. Unmarked tools remain registered and callable; the client defers
 * their schemas until it acquires them. Metadata is additive and preserves any
 * MCP metadata a tool already registered. */
function installAlwaysLoadMetadata(server: McpServer, opts: ClementineMcpServerOptions = {}): void {
  const alwaysLoad = new Set(resolvedAlwaysLoadTools(opts));
  if (alwaysLoad.size === 0) return;
  const wrapped = server.tool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { tool: (...args: any[]) => unknown }).tool = (...args: any[]) => {
    const toolName = typeof args[0] === 'string' ? args[0] : undefined;
    const result = wrapped(...args) as { _meta?: Record<string, unknown>; update?: (value: { _meta?: Record<string, unknown> }) => void } | undefined;
    if (result && toolName && alwaysLoad.has(toolName) && typeof result.update === 'function') {
      result.update({ _meta: { ...(result._meta ?? {}), 'anthropic/alwaysLoad': true } });
    }
    return result;
  };
}

export function createClementineMcpServer(opts: ClementineMcpServerOptions = {}): McpServer {
  ensureToolDirectories();
  const server = new McpServer({ name: 'clementine-next-tools', version: '0.3.0' });
  const registeredNames = new Set<string>();
  const deferredNames = new Set(resolvedDeferredTools(opts));
  const consideredDescriptors = new Map<string, SealableToolLike>();

  installAmbientToolContext(server, opts);
  installToolRegistrationObserver(server, (name, descriptor) => {
    registeredNames.add(name);
    if (descriptor) consideredDescriptors.set(name, descriptor);
    opts.onToolRegistered?.(name);
  });
  installAlwaysLoadMetadata(server, opts);
  // Install last so it is the outermost registration boundary: filtered tools
  // never reach metadata or registration observers.
  installToolAllowlistFilter(server, opts, deferredNames.size > 0
    ? (descriptor) => {
        const name = typeof descriptor.name === 'string' ? descriptor.name.trim() : '';
        if (name) consideredDescriptors.set(name, descriptor);
      }
    : undefined);
  const capabilityController = deferredNames.size > 0
    ? createMcpCapabilityController({ opts, registeredNames, deferredNames, consideredDescriptors })
    : null;
  if (capabilityController) MCP_CAPABILITY_CONTROLLERS.set(server, capabilityController);

  registerMemoryTools(server);
  registerFocusTools(server);
  registerVaultTools(server);
  registerPlanTools(server);
  registerSessionTools(server);
  registerGoalTools(server);
  registerAdminTools(server);
  registerTeamTools(server);
  registerOrchestrationTools(server);
  registerPendingActionTools(server);
  registerAgentRunsTools(server);
  registerBackgroundTaskTools(server);
  registerWorkerTools(server);
  registerWorkflowStateTools(server);
  registerTableOpsTools(server);
  registerDocumentProduceTools(server);
  registerFileQueryTools(server);
  registerTimeSlotsTools(server);
  registerExtractStructuredTools(server);
  registerBatchTools(server);
  registerAutonomyActionTools(server);
  registerExecutionTools(server);
  registerProfileTools(server);
  registerCapabilityTools(server);
  registerHarnessStatusTools(server);
  registerCliTools(server);
  // Lane parity (live 07-30): these were registered only on the Codex lane's
  // local-runtime surface, so the Claude SDK brain could not reach them —
  // tool_search came up empty and the model hand-rolled the SAME effect through
  // run_shell_command with --dangerously-skip-permissions-class flags. Both
  // tools carry their own gates (approved runners / workspace-roster boundary
  // + ask-first contracts), identical on both lanes.
  registerCliSetupTools(server);
  registerProjectRunTools(server);
  registerSkillTools(server);
  registerWorkflowScheduleTools(server);
  registerSpaceTools(server);
  registerMcpStatusTools(server);
  registerMcpServerTools(server);
  registerToolChoiceTools(server);
  registerModelRoleTools(server);
  // Recall tools (read-only): pull the verbatim/sliced payload of a clipped tool
  // result. Needed so the Claude Agent SDK lane can read large outputs (e.g. a
  // 25-row `sf data query`) the harness clipped — without them it hits the same
  // "tool not found" the @openai/agents lane was fixed for.
  registerRecallTools(server);
  registerArtifactClaimTools(server);
  // Exact JSON slices from run-workspace artifacts/offloaded step context.
  registerWorkspaceArtifactTools(server);
  registerDynamicTools(server);
  // Agent SDK lane only: expose the mutating tools (shell/composio/write) through
  // the full harness gate chain so the Claude Agent SDK can execute them safely.
  registerGatedMutatingTools(server, {
    enabled: opts.gatedMutations,
    sessionId: opts.sessionId,
    runScopeId: opts.runScopeId,
    sourceUserSeq: opts.sourceUserSeq,
    dispatchLease: opts.dispatchLease,
    directOrchestrator: opts.directOrchestrator,
    workerScope: opts.workerScope,
  });

  const actionExpectedWorkRequested = opts.actionExpectedWork
    ?? (process.env.CLEMENTINE_MCP_ACTION_EXPECTED_WORK ?? '').trim().toLowerCase() === 'on';
  const actionDispatcherOptions = {
    reachableBuiltinNames: deferredNames,
    firstClassNames: registeredNames,
    mcpToolScope: resolvedMcpToolScope(opts),
    ...(capabilityController ? {
      admitBuiltinAcquisition: (name: string) => capabilityController.admit(name),
    } : {}),
  };
  const actionWorkCallRegistered = registerClaudeActionWorkCall(server, {
    enabled: actionExpectedWorkRequested,
    sessionId: opts.sessionId,
    sourceUserSeq: opts.sourceUserSeq,
    runScopeId: opts.runScopeId,
    directOrchestrator: opts.directOrchestrator,
    dispatchLease: opts.dispatchLease,
    ...actionDispatcherOptions,
  });
  if (actionExpectedWorkRequested && !actionWorkCallRegistered) {
    throw new Error(
      'ACTION_EXPECTED_WORK_CARRIER_UNAVAILABLE: the exact action carrier could not be registered; refusing to construct a fallback business surface.',
    );
  }

  // Code Mode (Lane C) — expose run_tool_program on the Claude SDK lane too, so
  // BOTH brains can run a sandboxed program. Flag-gated (CLEMMY_CODE_MODE); the
  // in-program clem calls dispatch through the same gated path under this MCP
  // session. No-op when off.
  if (codeModeEnabled()) {
    const codeModeSessionId = opts.sessionId?.trim() || process.env.CLEMENTINE_MCP_SESSION_ID?.trim() || '';
    server.tool(
      'run_tool_program',
      codeModeDescription({ actionExpectedWork: actionWorkCallRegistered }),
      { program: z.string() },
      async (input: { program: string }) => {
        const r = await runCodeModeForSession(
          input.program,
          codeModeSessionId,
          actionWorkCallRegistered ? { workCallOptions: actionDispatcherOptions } : {},
        );
        return textResult(
          r.ok
            ? `code-mode program returned (${r.rpcCalls} tool call${r.rpcCalls === 1 ? '' : 's'}):\n${JSON.stringify(r.value)}`
            : `code-mode program failed: ${r.error}`,
          { isError: !r.ok },
        );
      },
    );
  }

  // Genuine schema-on-demand for the Claude SDK lane. Deferred tools are not
  // registered here (so their schemas cannot be billed in the provider prompt),
  // but remain callable through the same generic dispatcher and inner-tool gate
  // chain the Codex lane uses.
  if (deferredNames.size > 0 && !actionWorkCallRegistered) {
    registerCallToolMcp(server, {
      reachableBuiltinNames: deferredNames,
      // This Set is intentionally live: ping/tool_search/call_tool register
      // below and become valid first-class targets without rebuilding it.
      firstClassNames: registeredNames,
      mcpToolScope: resolvedMcpToolScope(opts),
      // A physical MCP server owns one sealed universe/revision chain. The
      // controller initializes lazily, but every acquisition awaits that seal
      // and fails closed before inner dispatch if authority cannot be proved.
      admitBuiltinAcquisition: (name) => capabilityController?.admit(name) ?? {
        ok: false,
        kind: 'requires_readmission',
        outside: [name],
        reason: 'the MCP capability controller is unavailable',
      },
    });
  }

  server.tool('ping', 'Basic health-check tool for the local MCP server.', {}, async () => textResult('pong'));

  // view_image (2026-08-07): the model LOOKS at a stored attachment image —
  // real pixels as an MCP image block, not the OCR/description text. Read-only
  // ('view' classifies read; never gated); the path guard inside
  // readImageForViewing confines reads to state/attachments-files.
  server.tool(
    'view_image',
    'Look at an attached image directly (the actual pixels, not a description). Pass the stored path given in the attachment block.',
    { path: z.string().min(1).describe('The stored image path from the attachment block (state/attachments-files/…).') },
    async (input: { path: string }) => {
      const { readImageForViewing } = await import('../runtime/attachments.js');
      const image = readImageForViewing(input.path);
      if (!image.ok) return textResult(`Could not view image: ${image.error}`);
      return {
        content: [
          { type: 'image' as const, data: image.base64, mimeType: image.mimeType },
          { type: 'text' as const, text: `Image ${image.name} (${image.mimeType}, ${(image.bytes / 1024).toFixed(0)}KB) shown above.` },
        ],
      };
    },
  );

  // Register discovery LAST. A normal allowlisted server searches only what it
  // actually registered. A schema-on-demand server additionally searches the
  // explicitly deferred authority set; every such result is callable through
  // call_tool in this same turn.
  const searchableNames = deferredNames.size > 0
    ? new Set([...registeredNames, ...deferredNames])
    : registeredNames;
  const brokerScope = resolvedMcpToolScope(opts);
  const directOrchestrator = opts.directOrchestrator
    ?? (process.env.CLEMENTINE_MCP_DIRECT_ORCHESTRATOR ?? '').trim().toLowerCase() === 'on';
  const candidateSources = actionWorkCallRegistered
    && directOrchestrator
    && brokerScope
    && mcpToolScopeAuthority(brokerScope) !== 'none'
    ? buildAuthorizedToolSearchCandidateSources(brokerScope)
    : undefined;
  registerToolSearchTool(server, {
    allowedNames: searchableNames,
    dispatchViaCallTool: deferredNames.size > 0 && !actionWorkCallRegistered,
    ...(deferredNames.size > 0 && actionWorkCallRegistered
      ? { dispatchCarrier: 'work_call' as const }
      : {}),
    ...(candidateSources ? { candidateSources } : {}),
  });
  return server;
}

/** Build the same feature-gated server used by the in-process Claude lane and
 * return its registered names. This prevents JIT from maintaining a parallel
 * approximation of the MCP capability surface. */
export function listClementineMcpToolNames(opts: { gatedMutations?: boolean } = {}): string[] {
  const names = new Set<string>();
  createClementineMcpServer({
    sessionId: '__mcp_surface_introspection__',
    gatedMutations: opts.gatedMutations,
    onToolRegistered: (name) => names.add(name),
  });
  return [...names];
}

function registerPluginTool(server: McpServer, tool: PluginTool): void {
  // Build a Zod schema from the JSON Schema properties
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, schemaDef] of Object.entries(properties)) {
    const def = schemaDef as { type?: string; description?: string; enum?: string[] };
    let zodType: z.ZodTypeAny;
    if (def.enum) {
      zodType = z.enum(def.enum as [string, ...string[]]);
    } else if (def.type === 'number' || def.type === 'integer') {
      zodType = z.number();
    } else if (def.type === 'boolean') {
      zodType = z.boolean();
    } else if (def.type === 'array') {
      zodType = z.array(z.unknown());
    } else {
      zodType = z.string();
    }
    if (!required.has(key)) {
      // v0.5.22 — .nullable() instead of .optional(). Codex strict mode
      // (SDK 0.11.5 default) requires every property in `required`;
      // optional fields must serialize as nullable so the field is
      // present with possibly-null value.
      zodType = zodType.nullable();
    }
    shape[key] = zodType;
  }

  server.tool(tool.name, tool.description, shape, async (input) => {
    return tool.handler(input as Record<string, unknown>);
  });
}

async function main(): Promise<void> {
  const server = createClementineMcpServer();

  // Load and register user plugins
  const plugins = await loadPlugins();
  let pluginToolCount = 0;
  for (const plugin of plugins) {
    for (const tool of plugin.tools ?? []) {
      try {
        registerPluginTool(server, tool);
        pluginToolCount++;
      } catch (err) {
        console.error(`[plugins] Failed to register tool "${tool.name}" from plugin "${plugin.name}":`, err);
      }
    }
  }
  if (plugins.length > 0) {
    console.error(`[plugins] Loaded ${plugins.length} plugin(s) with ${pluginToolCount} tool(s)`);
  }

  // A stdio child is itself the physical Claude query boundary. Build its
  // revision-1 authority after every built-in/plugin registration and before
  // the client can invoke call_tool. A refused seal leaves the handler's
  // typed requires_readmission gate in place; it never becomes unbounded.
  await initializeClementineMcpCapabilityAuthority(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1]
  : false;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
