export const PLAN_TASK_RESULT_MAX_BYTES = 64 * 1024;

export type PlanTaskRecoveryToolV1 =
  | 'plan_task'
  | 'tool_search'
  | 'call_tool'
  | 'workflow_run'
  | 'ask_user_question'
  | 'retry_host'
  | 'stop_factual';

export type PlanTaskRefusalDisposition = 'input_required' | 'settled_refusal';

export interface ExactPlanTaskRefusal {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly disposition: PlanTaskRefusalDisposition;
  /** Absent only for an exact legacy member written before structural routing. */
  readonly recoveryTool: PlanTaskRecoveryToolV1 | null;
  readonly structural: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const EFFECTS = new Set([
  'none',
  'read',
  'compute',
  'host_only',
  'unknown',
  'local_write',
  'external_write',
  'admin',
]);
const WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);
const RECOVERY_TOOLS = new Set<PlanTaskRecoveryToolV1>([
  'plan_task',
  'tool_search',
  'call_tool',
  'workflow_run',
  'ask_user_question',
  'retry_host',
  'stop_factual',
]);

export function exactPlanTaskResultRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor && descriptor.enumerable);
  });
}

export function exactPlanTaskResultKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  return keys.length === wanted.length
    && keys.every((key) => typeof key === 'string')
    && (keys as string[]).sort().every((key, index) => key === wanted[index]);
}

export function boundedPlanTaskResultText(value: unknown, maxBytes = 8_192): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !value.includes('\0');
}

export function exactPlanTaskResultId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function exactPlanTaskResultTextList(input: {
  value: unknown;
  maxItems: number;
  maxItemBytes: number;
  idOnly?: boolean;
  allowEmpty?: boolean;
}): input is typeof input & { value: string[] } {
  return Array.isArray(input.value)
    && (input.allowEmpty === true || input.value.length > 0)
    && input.value.length <= input.maxItems
    && input.value.every((entry) => (
      input.idOnly === true
        ? exactPlanTaskResultId(entry)
        : boundedPlanTaskResultText(entry, input.maxItemBytes)
    ))
    && new Set(input.value).size === input.value.length;
}

function exactRecoveryTool(value: unknown): value is PlanTaskRecoveryToolV1 {
  return typeof value === 'string' && RECOVERY_TOOLS.has(value as PlanTaskRecoveryToolV1);
}

function exactRepairCapabilities(value: unknown, writesOnly = false): boolean {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((entry) => (
      exactPlanTaskResultRecord(entry)
      && exactPlanTaskResultKeys(entry, ['capabilityRef', 'effect', 'purpose'])
      && exactPlanTaskResultId(entry.capabilityRef)
      && typeof entry.effect === 'string'
      && (writesOnly ? WRITE_EFFECTS.has(entry.effect) : EFFECTS.has(entry.effect))
      && boundedPlanTaskResultText(entry.purpose, 1_000)
    ))
    && new Set(value.map((entry) => (
      exactPlanTaskResultRecord(entry) ? entry.capabilityRef : undefined
    ))).size === value.length;
}

function exactWithheldCapabilities(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((entry) => (
      exactPlanTaskResultRecord(entry)
      && exactPlanTaskResultKeys(entry, ['id', 'effect', 'reason'])
      && exactPlanTaskResultId(entry.id)
      && typeof entry.effect === 'string'
      && EFFECTS.has(entry.effect)
      && boundedPlanTaskResultText(entry.reason, 1_000)
    ))
    && new Set(value.map((entry) => (
      exactPlanTaskResultRecord(entry) ? entry.id : undefined
    ))).size === value.length;
}

function parsed(value: unknown): Record<string, unknown> | null {
  let payload = value;
  if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > PLAN_TASK_RESULT_MAX_BYTES) return null;
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  return exactPlanTaskResultRecord(payload) ? payload : null;
}

function result(
  payload: Record<string, unknown>,
  disposition: PlanTaskRefusalDisposition,
  recoveryTool: PlanTaskRecoveryToolV1 | null,
  structural: boolean,
): ExactPlanTaskRefusal {
  return Object.freeze({ payload, disposition, recoveryTool, structural });
}

/** Exact closed union for every ordinary non-success returned by plan_task. */
export function parseExactPlanTaskRefusal(value: unknown): ExactPlanTaskRefusal | null {
  const payload = parsed(value);
  if (!payload || payload.ok !== false || typeof payload.code !== 'string') return null;

  if (payload.code === 'account_selection_required') {
    const common = boundedPlanTaskResultText(payload.detail)
      && boundedPlanTaskResultText(payload.question, 500)
      && exactPlanTaskResultTextList({
        value: payload.accountChoices,
        maxItems: 5,
        maxItemBytes: 256,
      })
      && boundedPlanTaskResultText(payload.repair);
    if (!common) return null;
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'question', 'accountChoices', 'repair', 'recoveryTool',
      ])
      && payload.recoveryTool === 'ask_user_question'
    ) return result(payload, 'input_required', 'ask_user_question', true);
    if (exactPlanTaskResultKeys(payload, [
      'ok', 'code', 'detail', 'question', 'accountChoices', 'repair',
    ])) return result(payload, 'input_required', null, false);
    return null;
  }

  if (payload.code === 'plan_invalid_input') {
    const common = boundedPlanTaskResultText(payload.detail)
      && boundedPlanTaskResultText(payload.repair);
    if (!common) return null;
    // Optional host-authored repair key (violated paths digest); a member
    // without it is the legacy shape and still parses unchanged.
    const keyed = 'repairKey' in payload;
    if (keyed && !(typeof payload.repairKey === 'string' && /^[a-f0-9]{16,64}$/.test(payload.repairKey))) {
      return null;
    }
    if (
      exactPlanTaskResultKeys(payload, keyed
        ? ['ok', 'code', 'detail', 'repair', 'recoveryTool', 'repairKey']
        : ['ok', 'code', 'detail', 'repair', 'recoveryTool'])
      && payload.recoveryTool === 'plan_task'
    ) return result(payload, 'settled_refusal', 'plan_task', true);
    if (exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair'])) {
      return result(payload, 'settled_refusal', null, false);
    }
    return null;
  }

  if (payload.code === 'plan_not_required') {
    if (!boundedPlanTaskResultText(payload.detail)) return null;
    if (
      exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair', 'recoveryTool'])
      && boundedPlanTaskResultText(payload.repair)
      && payload.recoveryTool === 'call_tool'
    ) return result(payload, 'settled_refusal', 'call_tool', true);
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'workflowName', 'repair', 'recoveryTool',
      ])
      && boundedPlanTaskResultText(payload.workflowName, 256)
      && boundedPlanTaskResultText(payload.repair)
      && payload.recoveryTool === 'workflow_run'
    ) return result(payload, 'settled_refusal', 'workflow_run', true);
    // Exact legacy members are settlement-compatible but carry no new routing
    // authority. The unique-workflow name remains a closed host nomination.
    if (
      exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail'])
      || (
        exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair'])
        && boundedPlanTaskResultText(payload.repair)
      )
    ) return result(payload, 'settled_refusal', null, false);
    if (
      exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair', 'workflowName'])
      && boundedPlanTaskResultText(payload.repair)
      && boundedPlanTaskResultText(payload.workflowName, 256)
    ) return result(payload, 'settled_refusal', null, false);
    return null;
  }

  if (payload.code === 'plan_incomplete_missing_write') {
    const common = boundedPlanTaskResultText(payload.detail)
      && (payload.requestedEffectScope === 'write' || payload.requestedEffectScope === 'mixed')
      && boundedPlanTaskResultText(payload.repair);
    if (!common) return null;
    // The current producer asks for the exact missing write and names no
    // substitutes: one tool_search is the only recovery. It carries no
    // capability list at all, by pin — offering card writes here is the
    // substitution incident.
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'requestedEffectScope', 'repair', 'recoveryTool',
      ])
      && payload.recoveryTool === 'tool_search'
    ) return result(payload, 'settled_refusal', 'tool_search', true);
    // Durable payloads written while the refusal advertised a bounded write
    // list keep their recorded routing.
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'requestedEffectScope', 'admissibleCapabilities',
        'repair', 'recoveryTool',
      ])
      && exactRepairCapabilities(payload.admissibleCapabilities, true)
      && (
        (payload.recoveryTool === 'tool_search'
          && (payload.admissibleCapabilities as unknown[]).length === 0)
        || (payload.recoveryTool === 'plan_task'
          && (payload.admissibleCapabilities as unknown[]).length > 0)
      )
    ) return result(payload, 'settled_refusal', payload.recoveryTool, true);
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'requestedEffectScope', 'admissibleCapabilities', 'repair',
      ])
      && exactRepairCapabilities(payload.admissibleCapabilities, true)
    ) return result(payload, 'settled_refusal', null, false);
    if (exactPlanTaskResultKeys(payload, [
      'ok', 'code', 'detail', 'requestedEffectScope', 'repair',
    ])) return result(payload, 'settled_refusal', null, false);
    return null;
  }

  if (payload.code === 'plan_incomplete_data_lineage') {
    const common = boundedPlanTaskResultText(payload.detail)
      && exactPlanTaskResultTextList({ value: payload.writeOperationIds, maxItems: 32, maxItemBytes: 128, idOnly: true })
      && exactPlanTaskResultTextList({ value: payload.sourceOperationIds, maxItems: 32, maxItemBytes: 128, idOnly: true })
      && boundedPlanTaskResultText(payload.repair);
    if (!common) return null;
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'writeOperationIds', 'sourceOperationIds', 'repair', 'recoveryTool',
      ])
      && payload.recoveryTool === 'plan_task'
    ) return result(payload, 'settled_refusal', 'plan_task', true);
    if (exactPlanTaskResultKeys(payload, [
      'ok', 'code', 'detail', 'writeOperationIds', 'sourceOperationIds', 'repair',
    ])) return result(payload, 'settled_refusal', null, false);
    return null;
  }

  if (payload.code === 'plan_not_admitted') {
    const common = boundedPlanTaskResultText(payload.detail)
      && boundedPlanTaskResultText(payload.repair);
    if (!common) return null;
    if (
      exactPlanTaskResultKeys(payload, [
        'ok', 'code', 'detail', 'reasonCode', 'admissibleCapabilities', 'ceiling',
        'withheld', 'repair', 'recoveryTool',
      ])
      && exactPlanTaskResultId(payload.reasonCode)
      && exactRepairCapabilities(payload.admissibleCapabilities)
      && typeof payload.ceiling === 'string'
      && EFFECTS.has(payload.ceiling)
      && exactWithheldCapabilities(payload.withheld)
      && (
        payload.recoveryTool === 'plan_task'
        || payload.recoveryTool === 'tool_search'
        || payload.recoveryTool === 'retry_host'
        || payload.recoveryTool === 'stop_factual'
      )
      && (payload.recoveryTool !== 'tool_search'
        || (payload.admissibleCapabilities as unknown[]).length === 0
        || payload.reasonCode === 'verification_successor_required'
        || payload.reasonCode === 'capability_not_disclosed')
    ) return result(payload, 'settled_refusal', payload.recoveryTool, true);
    if (exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair'])) {
      return result(payload, 'settled_refusal', null, false);
    }
    return null;
  }

  if (
    payload.code === 'verification_successor_required'
    || payload.code === 'plan_binding_not_sealed'
  ) {
    if (
      exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair', 'recoveryTool'])
      && boundedPlanTaskResultText(payload.detail)
      && boundedPlanTaskResultText(payload.repair)
      && exactRecoveryTool(payload.recoveryTool)
      && (
        (payload.code === 'verification_successor_required'
          && (
            payload.recoveryTool === 'plan_task'
            || payload.recoveryTool === 'tool_search'
            || payload.recoveryTool === 'stop_factual'
          ))
        || (payload.code === 'plan_binding_not_sealed' && payload.recoveryTool === 'stop_factual')
      )
    ) return result(payload, 'settled_refusal', payload.recoveryTool, true);
    return null;
  }

  return null;
}
