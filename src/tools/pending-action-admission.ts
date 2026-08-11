import { isDirectComposioActionSlug } from '../execution/workflow-direct-call.js';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import {
  irreversibleSendRequiresExplicitTarget,
  validateIrreversibleSendPayload,
} from '../runtime/harness/grounding-gate.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import { listDynamicToolNames } from './dynamic-tools.js';
import {
  composioExecutionUsesCliOnlyLane,
  getComposioCredentialStatus,
} from '../integrations/composio/client.js';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';
import {
  getComposioCliDefaultAccountAuthority,
  verifyComposioCliDefaultAccountAuthority,
  type ComposioCliDefaultAccountAuthority,
} from '../integrations/composio/cli-default-account-authority.js';
import { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';
import { resolveAccountAlias } from '../memory/account-alias-store.js';

const BUILT_IN_TOOL_NAMES = new Set(TOOL_REGISTRY.map((tool) => tool.name));

export type PendingActionAdmissionIntent = 'request_now' | 'queue_only' | 'legacy';

export interface CanonicalPendingActionCall {
  toolName: string;
  payload: unknown;
}

export interface AdmittedPendingActionCall extends CanonicalPendingActionCall {
  executionAuthority: ComposioCliDefaultAccountAuthority | null;
}

export interface PendingComposioExecutionAuthorityCheck {
  toolSlug: string;
  connectedAccountIds: Array<string | null | undefined>;
  /** Stable account identities snapshotted into action arguments. The CLI
   * cannot honor these selectors, even when its unrelated default is granted. */
  accountAliases?: unknown[];
  executionAuthority: ComposioCliDefaultAccountAuthority | null | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWrappedComposioActionSlug(value: string): boolean {
  return !BUILT_IN_TOOL_NAMES.has(value) && isDirectComposioActionSlug(value);
}

function isBareComposioActionSlug(value: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)
    && !listDynamicToolNames().includes(value)
    && isWrappedComposioActionSlug(value);
}

function stableEmail(value: unknown): string | undefined {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/^smtp:/, '')
    : '';
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : undefined;
}

/** Resolve a conversational account label exactly once at queue/proposal time.
 * Claim-time verification deliberately does NOT call this mutable store. */
export function resolveStableComposioAccountAlias(
  toolSlug: string,
  value: unknown,
): string | undefined {
  const direct = stableEmail(value);
  if (direct) return direct;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return stableEmail(resolveAccountAlias(value, registeredToolkitOfSlug(toolSlug))?.email);
}

function assertPendingIrreversibleSendPayload(
  toolSlug: string,
  args: Record<string, unknown>,
): void {
  if (!isIrreversibleSendSlug(toolSlug)) return;
  const validation = validateIrreversibleSendPayload(toolSlug, args);
  if (!validation.ok) {
    throw new Error(validation.detail ?? `${toolSlug} has an invalid irreversible-send payload.`);
  }
}

/**
 * Normalize the two model-facing Composio spellings into the one executable
 * broker call stored in the immutable approval snapshot. A card must never be
 * minted for a payload that the approved executor cannot invoke.
 */
export function canonicalizePendingActionCall(
  toolNameInput: string,
  payloadInput: unknown,
): CanonicalPendingActionCall {
  const toolName = toolNameInput.trim();
  if ((toolName.split('__').at(-1) ?? toolName) === 'call_tool') {
    throw new Error(
      'call_tool cannot be stored as a pending action. Queue the validated inner toolName and its exact payload instead.',
    );
  }
  if (toolName === 'composio_execute_tool') {
    if (!isPlainRecord(payloadInput)) {
      throw new Error(
        'composio_execute_tool payloadJson must be an object with tool_slug and arguments.',
      );
    }
    const allowed = new Set(['tool_slug', 'arguments', 'connected_account_id']);
    const unexpected = Object.keys(payloadInput).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new Error(
        `composio_execute_tool payloadJson contains unsupported transport field(s): ${unexpected.join(', ')}. `
        + 'Put action fields inside arguments.',
      );
    }
    const slug = typeof payloadInput.tool_slug === 'string'
      ? payloadInput.tool_slug.trim()
      : '';
    if (!slug || !isWrappedComposioActionSlug(slug)) {
      throw new Error(
        'composio_execute_tool payloadJson requires a concrete Composio action slug in tool_slug.',
      );
    }
    let argumentsJson: string;
    let parsedArguments: Record<string, unknown>;
    if (typeof payloadInput.arguments === 'string') {
      try {
        const parsed = JSON.parse(payloadInput.arguments) as unknown;
        if (!isPlainRecord(parsed)) throw new Error('not an object');
        parsedArguments = parsed;
      } catch {
        throw new Error(
          'composio_execute_tool arguments must be a valid JSON-object string or a plain object.',
        );
      }
      argumentsJson = payloadInput.arguments;
    } else if (isPlainRecord(payloadInput.arguments)) {
      parsedArguments = payloadInput.arguments;
      argumentsJson = JSON.stringify(payloadInput.arguments);
    } else {
      throw new Error(
        'composio_execute_tool arguments must be a valid JSON-object string or a plain object.',
      );
    }
    assertPendingIrreversibleSendPayload(slug, parsedArguments);
    const rawConnection = payloadInput.connected_account_id;
    if (
      rawConnection !== undefined
      && rawConnection !== null
      && (typeof rawConnection !== 'string' || !rawConnection.trim())
    ) {
      throw new Error('composio_execute_tool connected_account_id must be a non-empty string or null.');
    }
    return {
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: slug,
        arguments: argumentsJson,
        connected_account_id: typeof rawConnection === 'string'
          ? rawConnection.trim()
          : null,
      },
    };
  }

  if (isBareComposioActionSlug(toolName)) {
    if (!isPlainRecord(payloadInput)) {
      throw new Error(
        `Direct Composio action ${toolName} requires a plain JSON-object payload.`,
      );
    }
    assertPendingIrreversibleSendPayload(toolName, payloadInput);
    return {
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: toolName,
        arguments: JSON.stringify(payloadInput),
        connected_account_id: null,
      },
    };
  }

  return { toolName, payload: payloadInput };
}

/**
 * Trusted queue admission shared by model-facing queueing and deterministic
 * judge-outage minting. Models cannot provide the execution capability.
 */
export function admitPendingActionCall(
  toolNameInput: string,
  payloadInput: unknown,
  options: { approvalIntent: PendingActionAdmissionIntent },
): AdmittedPendingActionCall {
  let canonical = canonicalizePendingActionCall(toolNameInput, payloadInput);
  if (canonical.toolName !== 'composio_execute_tool' || !isPlainRecord(canonical.payload)) {
    return { ...canonical, executionAuthority: null };
  }

  const slug = typeof canonical.payload.tool_slug === 'string'
    ? canonical.payload.tool_slug.trim()
    : '';
  const connectedAccountId = typeof canonical.payload.connected_account_id === 'string'
    ? canonical.payload.connected_account_id.trim()
    : '';
  const cliOnlyLane = composioExecutionUsesCliOnlyLane(getComposioCredentialStatus());
  const formalApproval = options.approvalIntent !== 'queue_only';
  const write = classifyComposioSlugEffect(slug) !== 'read';
  let accountAlias = '';
  const canonicalPayload = canonical.payload;
  const parsedArguments = typeof canonicalPayload.arguments === 'string'
    ? JSON.parse(canonicalPayload.arguments) as unknown
    : canonicalPayload.arguments;
  if (isPlainRecord(parsedArguments) && Object.prototype.hasOwnProperty.call(parsedArguments, 'account_alias')) {
    const rawAccountAlias = parsedArguments.account_alias;
    const stableAlias = resolveStableComposioAccountAlias(slug, rawAccountAlias);
    if (!stableAlias && (write || formalApproval)) {
      const detail = typeof rawAccountAlias === 'string' && rawAccountAlias.trim()
        ? `account_alias "${rawAccountAlias.trim()}" is not bound to a stable ${registeredToolkitOfSlug(slug)} email identity`
        : 'account_alias must be a non-empty string bound to a stable email identity';
      throw new Error(`${slug} ${detail}. No approval card or provider dispatch was created.`);
    }
    if (stableAlias) {
      accountAlias = stableAlias;
      canonical = {
        ...canonical,
        payload: {
          ...canonicalPayload,
          arguments: JSON.stringify({ ...parsedArguments, account_alias: stableAlias }),
        },
      };
    }
  }
  const accountScopedBroadcast =
    isIrreversibleSendSlug(slug)
    && !irreversibleSendRequiresExplicitTarget(slug);

  if (accountAlias && connectedAccountId) {
    throw new Error(
      `${slug} carries both account_alias "${accountAlias}" and connected_account_id "${connectedAccountId}". `
      + 'Choose one immutable account selector. No approval card or provider dispatch was created.',
    );
  }

  if (cliOnlyLane && accountAlias && formalApproval) {
    throw new Error(
      `${slug} is bound to account_alias "${accountAlias}", but the Composio CLI can execute only against its `
      + 'provider-side default and cannot honor an alias or standing draft-mailbox selector. Use the SDK/AUTO lane '
      + 'with a Composio API key. No approval card or provider dispatch was created.',
    );
  }

  if (cliOnlyLane && connectedAccountId && formalApproval) {
    throw new Error(
      `${slug} selects connected_account_id "${connectedAccountId}", but the Composio CLI cannot honor account-targeted selectors. `
      + 'Use the SDK/AUTO lane with a Composio API key, or remove the selector and explicitly authorize the CLI default in Connect. '
      + 'No approval card or provider dispatch was created.',
    );
  }

  if (cliOnlyLane && write && !connectedAccountId) {
    const toolkit = registeredToolkitOfSlug(slug);
    const authority = getComposioCliDefaultAccountAuthority(toolkit);
    if (authority) return { ...canonical, executionAuthority: authority };
    if (formalApproval) {
      throw new Error(
        `${slug} would write through the Composio CLI's unidentified ${toolkit} default account. `
        + `An operator must verify and authorize that named ${toolkit} CLI default in Connect before this exact payload can open an approval card. `
        + 'Use approvalIntent:"queue_only" only to keep it preparatory. No approval card or provider dispatch was created.',
      );
    }
    return { ...canonical, executionAuthority: null };
  }

  if (accountScopedBroadcast && !connectedAccountId && !accountAlias && formalApproval) {
    throw new Error(
      `${slug} is an account-scoped publish, so its formal approval path requires either a non-empty connected_account_id `
      + 'in the immutable SDK snapshot or a durable operator-authorized CLI-default snapshot. Resolve the exact destination, '
      + 'then queue it again. Use approvalIntent:"queue_only" only while the destination is preparatory. '
      + 'No approval card or provider dispatch was created.',
    );
  }

  return { ...canonical, executionAuthority: null };
}

/**
 * Claim-time counterpart to admission. Queue producers may be added over time,
 * but every executor can share this one route-capability check under its atomic
 * APPROVED→EXECUTING claim. The account identifiers are item-scoped for a
 * batch and single-element for a normal pending action.
 */
export function verifyPendingComposioExecutionAuthority(
  input: PendingComposioExecutionAuthorityCheck,
): string | null {
  const slug = input.toolSlug.trim();
  const authority = input.executionAuthority ?? null;
  const rawAliases = input.accountAliases ?? [];
  const selectorCount = Math.max(input.connectedAccountIds.length, rawAliases.length, 1);
  const selectors = Array.from({ length: selectorCount }, (_, index) => {
    const rawConnection = input.connectedAccountIds[index];
    const connectedAccountId = typeof rawConnection === 'string' && rawConnection.trim()
      ? rawConnection.trim()
      : null;
    const rawAlias = rawAliases[index];
    const aliasCarrierPresent = index < rawAliases.length && rawAlias !== undefined;
    const accountAlias = aliasCarrierPresent ? stableEmail(rawAlias) ?? null : null;
    return {
      connectedAccountId,
      accountAlias,
      invalidAlias: aliasCarrierPresent && !accountAlias,
    };
  });
  const hasPinnedAccount = selectors.some((selector) => Boolean(selector.connectedAccountId));
  const hasUnpinnedAccount = selectors.some((selector) => !selector.connectedAccountId);
  const hasAliasBoundAccount = selectors.some((selector) => Boolean(selector.accountAlias));
  const hasUnboundAccount = selectors.some((selector) => !selector.connectedAccountId && !selector.accountAlias);
  const write = classifyComposioSlugEffect(slug) !== 'read';
  const cliOnlyLane = composioExecutionUsesCliOnlyLane(getComposioCredentialStatus());
  const accountScopedBroadcast =
    isIrreversibleSendSlug(slug)
    && !irreversibleSendRequiresExplicitTarget(slug);

  if (selectors.some((selector) => selector.invalidAlias)) {
    return 'The approved action carries an account_alias that is not a stable email identity; mutable labels and non-string aliases cannot be resolved at claim time.';
  }
  if (selectors.some((selector) => selector.accountAlias && selector.connectedAccountId)) {
    return 'The approved action carries conflicting account_alias and connected_account_id selectors on the same item.';
  }

  if (authority) {
    if (!write || hasPinnedAccount || hasAliasBoundAccount) {
      return 'The CLI-default capability does not match this action route.';
    }
    if (!cliOnlyLane) {
      return 'The Composio backend changed after approval; this CLI-default capability cannot authorize an SDK/default route.';
    }
    if (registeredToolkitOfSlug(slug) !== authority.toolkit) {
      return 'The CLI-default capability is scoped to a different toolkit.';
    }
    const verified = verifyComposioCliDefaultAccountAuthority(authority);
    return verified.ok ? null : verified.reason;
  }

  if (cliOnlyLane && hasAliasBoundAccount) {
    return 'The Composio CLI cannot honor one or more account_alias selectors in this approved action; its default account cannot be substituted.';
  }

  if (accountScopedBroadcast && hasUnboundAccount) {
    return `${slug || 'This social publish'} has no immutable account destination: neither connected_account_id nor a CLI-default grant snapshot is present for every item.`;
  }
  if (cliOnlyLane && hasPinnedAccount) {
    return 'The Composio CLI cannot honor one or more connected_account_id selectors in this approved action.';
  }
  if (cliOnlyLane && write && hasUnpinnedAccount) {
    return `${slug || 'This Composio write'} has no durable operator-authorized CLI-default snapshot.`;
  }
  return null;
}
