import { tool, type Tool } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { needsApprovalFromTaxonomy } from '../agents/tool-taxonomy.js';
import { registerAdminTools } from './admin-tools.js';
import { registerAgentRunsTools } from './agent-runs-tools.js';
import { registerAutonomyActionTools } from './autonomy-action-tools.js';
import { registerBackgroundTaskTools } from './background-task-tools.js';
import { registerBatchTools } from './batch-tools.js';
import { registerBrowserHarnessTools } from './browser-harness-tools.js';
import { registerCapabilityTools } from './capability-tools.js';
import { registerCliTools } from './cli-tools.js';
import { registerSkillTools } from './skill-tools.js';
import { registerToolChoiceTools } from './tool-choice-tools.js';
import { registerModelRoleTools } from './model-role-tools.js';
import { registerWorkflowScheduleTools } from './workflow-schedule-tools.js';
import { registerSpaceTools } from './space-tools.js';
import { registerDynamicTools } from './dynamic-tools.js';
import { registerExecutionTools } from './execution-tools.js';
import { registerGoalTools } from './goal-tools.js';
import { registerMemoryTools } from './memory-tools.js';
import { registerFocusTools } from './focus-tools.js';
import { registerMcpStatusTools } from './mcp-status-tools.js';
import { registerMcpServerTools } from './mcp-server-tools.js';
import { registerOrchestrationTools } from './orchestration-tools.js';
import { registerPendingActionTools } from './pending-action-tools.js';
import { registerStepResultTool } from './step-result-tool.js';
import { registerWorkflowStateTools } from './workflow-state-tools.js';
import { registerTableOpsTools } from './table-ops-tools.js';
import { registerDocumentProduceTools } from './document-produce-tools.js';
import { registerFileQueryTools } from './file-query-tools.js';
import { registerTimeSlotsTools } from './time-slots-tools.js';
import { registerExtractStructuredTools } from './extract-structured-tools.js';
import { registerPlanTools } from './plan-tools.js';
import { registerProfileTools } from './profile-tools.js';
import { registerRecallTools } from './recall-tools.js';
import { registerArtifactClaimTools } from './artifact-claim-tools.js';
import { registerWorkspaceArtifactTools } from './workspace-artifact-tools.js';
import { registerToolSearchTool } from './tool-search-tool.js';
import { registerHarnessStatusTools } from './harness-status-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerVaultTools } from './vault-tools.js';
import { ensureToolDirectories, textResult } from './shared.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { toolOutputContextFromSdk, withToolOutputContext } from '../runtime/harness/tool-output-context.js';

type LocalToolHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

interface CapturedLocalTool {
  name: string;
  description: string;
  parameters: z.ZodRawShape;
  handler: LocalToolHandler;
  approvalRequired?: boolean;
}

// `create_tool` and `delete_agent` are admin tools in
// agents/tool-taxonomy.ts. `workspace_config` is mixed-mode there:
// list is read-only, add/remove are admin.

function resultToText(result: unknown): string {
  if (typeof result === 'string') return formatRecallableToolText(result);
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
            return (item as { text: string }).text;
          }
          return JSON.stringify(item);
        })
        .filter(Boolean)
        .join('\n');
      if (text) return formatRecallableToolText(text);
    }
  }

  try {
    return formatRecallableToolText(JSON.stringify(result, null, 2));
  } catch {
    return formatRecallableToolText(String(result));
  }
}

interface JsonStringToken {
  value: string;
  end: number;
}

function skipJsonWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && /\s/.test(input[cursor] ?? '')) cursor += 1;
  return cursor;
}

/** Read one fully valid JSON string without requiring the rest of the object to
 * parse. This lets the boundary retain an already-complete required prefix when
 * corruption occurs later in optional annotations. */
function readJsonStringToken(input: string, start: number): JsonStringToken | null {
  const first = skipJsonWhitespace(input, start);
  if (input[first] !== '"') return null;
  let cursor = first + 1;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === '"') {
      const raw = input.slice(first, cursor + 1);
      try {
        const value = JSON.parse(raw) as unknown;
        return typeof value === 'string' ? { value, end: cursor + 1 } : null;
      } catch {
        return null;
      }
    }
    if (char === '\\') {
      cursor += 1;
      if (cursor >= input.length) return null;
      if (input[cursor] === 'u') {
        const hex = input.slice(cursor + 1, cursor + 5);
        if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
        cursor += 4;
      }
    } else if ((char?.charCodeAt(0) ?? 0) < 0x20) {
      return null;
    }
    cursor += 1;
  }
  return null;
}

function consumeJsonPunctuation(input: string, start: number, expected: string): number | null {
  const cursor = skipJsonWhitespace(input, start);
  return input[cursor] === expected ? cursor + 1 : null;
}

/**
 * Narrow recovery for the only safe case observed in live proof:
 * memory_remember produced a valid, schema-ordered `kind` + `content` prefix,
 * then malformed an OPTIONAL graph annotation. Saving that already-grounded
 * local fact is safer and cheaper than asking the model to repeat the mutation.
 *
 * This is intentionally NOT generic JSON repair:
 *   - requires the exact leading object shape emitted by our schema;
 *   - accepts only ordinary, idempotent fact kinds (never a hard constraint);
 *   - requires kind/content to be complete JSON strings and within schema bounds;
 *   - discards every optional field rather than guessing how to repair it.
 * Any other corruption follows the SDK's normal visible retry path.
 */
export function recoverMemoryRememberRequiredPrefix(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null;
  const name = (error as { name?: unknown }).name;
  const toolInvocation = (error as { toolInvocation?: unknown }).toolInvocation;
  if (name !== 'InvalidToolInputError' || !toolInvocation || typeof toolInvocation !== 'object') return null;
  const raw = (toolInvocation as { input?: unknown }).input;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 20_000) return null;

  let cursor = consumeJsonPunctuation(raw, 0, '{');
  if (cursor === null) return null;
  const kindKey = readJsonStringToken(raw, cursor);
  if (!kindKey || kindKey.value !== 'kind') return null;
  cursor = consumeJsonPunctuation(raw, kindKey.end, ':');
  if (cursor === null) return null;
  const kind = readJsonStringToken(raw, cursor);
  if (!kind) return null;
  cursor = consumeJsonPunctuation(raw, kind.end, ',');
  if (cursor === null) return null;
  const contentKey = readJsonStringToken(raw, cursor);
  if (!contentKey || contentKey.value !== 'content') return null;
  cursor = consumeJsonPunctuation(raw, contentKey.end, ':');
  if (cursor === null) return null;
  const content = readJsonStringToken(raw, cursor);
  if (!content) return null;
  const next = raw[skipJsonWhitespace(raw, content.end)];
  if (next !== ',' && next !== '}') return null;

  const safeKinds = new Set(['user', 'project', 'feedback', 'reference']);
  const cleanContent = content.value.trim();
  if (!safeKinds.has(kind.value) || cleanContent.length < 3 || cleanContent.length > 800) return null;
  return { kind: kind.value, content: cleanContent };
}

// v0.5.22 — moved the body of this normalizer to
// `src/runtime/schema-normalizer.ts` so agent outputType schemas can
// share the same transformation. The helpers below are thin re-exports
// to keep the existing call sites in this file compiling unchanged.
import {
  normalizeZodForCodexStrict as normalizeZodForResponses,
  normalizeShapeForCodexStrict as normalizeShapeForResponses,
} from '../runtime/schema-normalizer.js';
export { normalizeZodForResponses, normalizeShapeForResponses };


function captureLocalTools(): CapturedLocalTool[] {
  ensureToolDirectories();
  const captured: CapturedLocalTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      parameters: z.ZodRawShape,
      handler: LocalToolHandler,
    ): void {
      captured.push({ name, description, parameters, handler });
    },
  };
  const server = fakeServer as unknown as McpServer;

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
  registerStepResultTool(server);
  registerWorkflowStateTools(server);
  registerTableOpsTools(server);
  registerDocumentProduceTools(server);
  registerFileQueryTools(server);
  registerTimeSlotsTools(server);
  registerExtractStructuredTools(server);

  // NOTE (2026-06-11 audit): the former `pause_for_user_approval` tool was
  // DELETED here. It was a broken duplicate of the real HITL path — it created
  // an in-memory gate with no response route, no UI, no durability, and told
  // the model "awaiting approval" while nothing ever waited. Mid-workflow
  // human sign-off is the declarative gate: split the step and put
  // `requiresApproval: true` (+ `approvalPreview`) on the gated step — the
  // runner registers a durable approval (console + Discord + notifications),
  // parks the run, and resumes on the user's decision.

  registerAgentRunsTools(server);
  registerBackgroundTaskTools(server);
  registerBatchTools(server);
  registerAutonomyActionTools(server);
  registerExecutionTools(server);
  registerProfileTools(server);
  registerRecallTools(server);
  registerWorkspaceArtifactTools(server);
  // Schema-on-demand discovery entry — read-only catalog search
  // (SCHEMA-ON-DEMAND-PLAN-2026-07-07). Additive + dormant in Phase 0.
  registerToolSearchTool(server);
  registerArtifactClaimTools(server);
  registerCapabilityTools(server);
  registerHarnessStatusTools(server);
  registerCliTools(server);
  registerSkillTools(server);
  registerToolChoiceTools(server);
  registerModelRoleTools(server);
  registerWorkflowScheduleTools(server);
  registerSpaceTools(server);
  registerBrowserHarnessTools(server);
  registerMcpStatusTools(server);
  registerMcpServerTools(server);
  const dynamicToolStart = captured.length;
  registerDynamicTools(server);
  for (const dynamicTool of captured.slice(dynamicToolStart)) {
    dynamicTool.approvalRequired = true;
  }

  captured.push({
    name: 'ping',
    description: 'Basic health-check tool for the local Clementine tool runtime.',
    parameters: {},
    handler: async () => textResult('pong'),
  });

  return captured;
}

function localToolToRuntimeTool(localTool: CapturedLocalTool): Tool<RuntimeContextValue> {
  return tool({
    name: localTool.name,
    description: localTool.description,
    parameters: z.object(normalizeShapeForResponses(localTool.parameters)),
    // Unified taxonomy. The captured tool's `approvalRequired` flag is
    // honored via a destructive-hint so dynamic tools that the runtime
    // marks as "always ask" still pause regardless of policy scope.
    needsApproval: needsApprovalFromTaxonomy(localTool.name, {
      isDestructive: (input) =>
        Boolean(localTool.approvalRequired),
    }),
    execute: async (input, runContext, details) => withToolOutputContext(
      toolOutputContextFromSdk(localTool.name, runContext, details),
      async () => resultToText(await localTool.handler(input as Record<string, unknown>)),
    ),
    // A malformed optional graph tail must not force a second memory mutation
    // attempt when kind/content were already complete. Keep this recovery local
    // and narrow; every other tool/error retains the SDK's default behavior.
    errorFunction: localTool.name === 'memory_remember'
      ? async (runContext, error) => {
          const recovered = recoverMemoryRememberRequiredPrefix(error);
          if (!recovered) {
            return 'memory_remember input was invalid. Retry once with only the required kind and content fields; omit optional graph annotations.';
          }
          const details = error && typeof error === 'object'
            ? (error as { toolInvocation?: { details?: unknown } }).toolInvocation?.details
            : undefined;
          return withToolOutputContext(
            toolOutputContextFromSdk(localTool.name, runContext, details),
            async () => {
              const result = resultToText(await localTool.handler(recovered));
              return `${result}\n[Recovered valid kind/content; malformed optional graph annotations were ignored.]`;
            },
          );
        }
      : undefined,
  });
}

export function getLocalRuntimeTools(): Tool<RuntimeContextValue>[] {
  return captureLocalTools().map(localToolToRuntimeTool);
}

let cachedLocalToolCatalog: Array<{ name: string; description: string }> | null = null;

/** Lightweight, schema-free inventory for the Console. This is generated from
 * the exact in-process registration surface, not the broader static taxonomy,
 * so the UI only claims tools Clementine actually loaded. The local surface is
 * immutable for a daemon lifetime, so cache it instead of rebuilding every
 * 15-second dashboard poll. */
export function getLocalToolCatalog(): Array<{ name: string; description: string }> {
  if (!cachedLocalToolCatalog) {
    cachedLocalToolCatalog = captureLocalTools().map(({ name, description }) => ({ name, description }));
  }
  return cachedLocalToolCatalog.map((entry) => ({ ...entry }));
}

/** Build the Codex lane's tool_search against the exact deferred surface for
 * this turn. The static runtime tool remains available for non-schema-on-demand
 * lanes; this scoped instance prevents discovery from promising a tool that the
 * active call_tool dispatcher cannot reach. */
export function buildScopedLocalToolSearch(allowedNames: ReadonlySet<string>): Tool<RuntimeContextValue> {
  const captured: CapturedLocalTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      parameters: z.ZodRawShape,
      handler: LocalToolHandler,
    ): void {
      captured.push({ name, description, parameters, handler });
    },
  };
  registerToolSearchTool(fakeServer as unknown as McpServer, { allowedNames });
  const localTool = captured[0];
  if (!localTool) throw new Error('tool_search did not register');
  return localToolToRuntimeTool(localTool);
}

/**
 * Zod schema for every local runtime tool, keyed by name — the SAME schema
 * getLocalRuntimeTools() builds each tool with. call_tool (call-tool.ts) uses this
 * to validate args_json before generic dispatch and to return the schema on a
 * validation miss. Side-effect-free (captureLocalTools registers against a fake
 * server); safe to call on demand.
 */
export function getLocalToolSchemas(): Map<string, z.ZodTypeAny> {
  const map = new Map<string, z.ZodTypeAny>();
  for (const localTool of captureLocalTools()) {
    const strictShape = normalizeShapeForResponses(localTool.parameters);
    const deferredShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, raw] of Object.entries(localTool.parameters)) {
      const normalized = strictShape[key] as z.ZodTypeAny;
      // Codex first-class schemas must encode optional fields as required +
      // nullable for strict JSON Schema. args_json is ordinary JSON, though:
      // models naturally omit optional keys. Preserve null compatibility while
      // also accepting omission so call_tool does not waste a round trip merely
      // adding `kind:null` / `includeInactive:false` / `content:""`.
      // On the deferred JSON-string transport, omission and explicit null are
      // equivalent for a field whose schema accepts null. Provider-strict
      // first-class tools still receive an explicit null below via
      // getLocalToolOptionalKeys(). Accepting omission here prevents a
      // schema-correction turn for ordinary calls such as
      // space_refresh({slug}) / space_get_runner({slug, runner_path}).
      deferredShape[key] = (
        (raw as z.ZodTypeAny).safeParse(undefined).success
        || (raw as z.ZodTypeAny).safeParse(null).success
      )
        ? normalized.optional()
        : normalized;
    }
    // First-class provider schemas already declare additionalProperties:false.
    // The deferred dispatcher must preserve that contract too: a plain
    // z.object silently strips unknown keys. That allowed stale camelCase
    // arguments such as space_save({dataSources, viewHtml}) to disappear while
    // the remaining slug/title/view_path dispatched successfully, producing a
    // static Workspace that Clementine falsely reported as data-connected.
    map.set(localTool.name, z.strictObject(deferredShape));
  }
  return map;
}

/** Omissible fields on the deferred transport. Codex's strict first-class
 * schema represents both optional and nullable fields as required+nullable, so
 * args_json dispatch materializes an omitted key as null before invoking that
 * strict inner tool. */
export function getLocalToolOptionalKeys(): Map<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const localTool of captureLocalTools()) {
    map.set(localTool.name, new Set(
      Object.entries(localTool.parameters)
        .filter(([, raw]) =>
          (raw as z.ZodTypeAny).safeParse(undefined).success
          || (raw as z.ZodTypeAny).safeParse(null).success)
        .map(([key]) => key),
    ));
  }
  return map;
}
