/**
 * Every irreversible external send Clem performs — from a chat turn or a
 * workflow step, to any provider — is mirrored as one first-party
 * notification carrying what was sent and where. Live 2026-09-22: a
 * scheduled workflow posted the team digest to a Slack channel; the desktop
 * only got "Workflow completed" in Clem's voice, and the digest itself never
 * reached the first-party surfaces. The mirror is in-app only (never queued
 * back out to a channel, which would loop) and keyed by the call, so it is
 * written at most once per send.
 */
import { addNotification } from '../notifications.js';
import { registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';

export interface ExternalSendMirrorInput {
  sessionId: string;
  callId: string | null | undefined;
  toolName: string;
  accounting: { effect: string; toolSlug?: string; reversibility?: 'reversible' | 'irreversible' };
  /** The call arguments as the runtime received them (JSON text or object). */
  rawArgs: unknown;
  ok: boolean;
}

export interface ExternalSendMirrorNotification {
  id: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

function decodeArgs(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The provider-facing arguments: a gateway call carries them under
 *  `arguments`; a direct tool carries them at the top level. */
function providerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const inner = args.arguments;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  if (typeof inner === 'string') return decodeArgs(inner) ?? args;
  return args;
}

function flattenStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>, depth = 0): void {
  if (depth > 3) return;
  if (typeof value === 'string') { if (value.trim()) out.push({ path, text: value }); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => flattenStrings(item, `${path}[${index}]`, out, depth + 1)); return; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) flattenStrings(child, path ? `${path}.${key}` : key, out, depth + 1);
  }
}

function toolkitLabel(slug: string | undefined, toolName: string): string {
  const toolkit = slug ? registeredToolkitOfSlug(slug.toUpperCase()).trim() : '';
  const base = toolkit || toolName.split('_')[0] || 'a connected app';
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

/** Parse `workflow:<runId>:<stepId>` session ids; anything else is a chat turn. */
function workflowStepOf(sessionId: string): { runId: string; stepId: string } | null {
  const match = /^workflow:([^:]+):(.+)$/.exec(sessionId);
  return match ? { runId: match[1], stepId: match[2] } : null;
}

/**
 * The notification to mirror, or null when the settled call was not a
 * successful irreversible external send. The message is the longest string
 * the call carried (the body of any send); the shorter strings are its
 * destination and subject lines. No provider or field names are assumed.
 */
export function externalSendMirrorNotification(input: ExternalSendMirrorInput, now = new Date()): ExternalSendMirrorNotification | null {
  if (!input.ok) return null;
  if (input.accounting.effect !== 'external_write' || input.accounting.reversibility !== 'irreversible') return null;
  const args = decodeArgs(input.rawArgs);
  if (!args) return null;
  const strings: Array<{ path: string; text: string }> = [];
  flattenStrings(providerArgs(args), '', strings);
  const message = strings.reduce<{ path: string; text: string } | null>((best, row) => (
    !best || row.text.length > best.text.length ? row : best
  ), null);
  if (!message) return null;
  const details = strings
    .filter((row) => row !== message && row.text.length <= 120)
    .slice(0, 4)
    .map((row) => `${row.path}: ${row.text}`);
  const label = toolkitLabel(input.accounting.toolSlug, input.toolName);
  const step = workflowStepOf(input.sessionId);
  const callKey = (input.callId ?? '').trim() || `${input.sessionId}:${now.getTime()}`;
  return {
    id: `sent:${callKey}`,
    title: step ? `Sent via ${label} by a workflow step` : `Sent via ${label}`,
    body: [
      message.text.length > 1_500 ? `${message.text.slice(0, 1_500)}…` : message.text,
      ...(details.length > 0 ? ['', ...details] : []),
    ].join('\n'),
    metadata: {
      source: 'external-send',
      // In-app only: the mirror of a send must never be queued back out to a
      // channel, or every send would echo itself.
      inboxOnly: true,
      toolkit: label,
      ...(input.accounting.toolSlug ? { operation: input.accounting.toolSlug } : {}),
      sessionId: input.sessionId,
      ...(input.callId ? { callId: input.callId } : {}),
      ...(step ? { runId: step.runId, stepId: step.stepId } : {}),
    },
  };
}

/** Best-effort: a failed mirror never affects the send it describes. */
export function mirrorExternalSendToFirstPartySurfaces(input: ExternalSendMirrorInput): boolean {
  try {
    const notification = externalSendMirrorNotification(input);
    if (!notification) return false;
    addNotification({
      id: notification.id,
      kind: 'system',
      title: notification.title,
      body: notification.body,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: notification.metadata,
    });
    return true;
  } catch {
    return false;
  }
}
