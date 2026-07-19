import { getRuntimeEnv } from '../../config.js';
import { listEvents, recentToolOutputs } from './eventlog.js';
import { extractDuplicateIdentityKeys } from './grounding-gate.js';

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ECHO_TOOL_RE = /^(?:pending_action_|request_approval|approval_|memory_remember$|execution_|notify_user$)/i;

export interface RecipientIntegritySource {
  id: string;
  tool: string | null;
  recipients: string[];
}

export interface RecipientIntegrityResult {
  action: 'allow' | 'block';
  reason: string;
  recipients: string[];
  sourceId?: string;
  unsupportedRecipients?: string[];
}

export function isRecipientIntegrityGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_RECIPIENT_SET_INTEGRITY', 'on') ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'disabled'].includes(raw);
}

function emailSet(value: unknown): string[] {
  return extractDuplicateIdentityKeys(value)
    .filter((item) => EMAIL_RE.test(item))
    .map((item) => item.toLowerCase())
    .sort();
}

function trustedRecipientSources(sessionId: string): RecipientIntegritySource[] {
  const sources: RecipientIntegritySource[] = [];
  const events = listEvents(sessionId, { types: ['user_input_received', 'tool_returned'] });
  for (const event of events) {
    if (event.type !== 'user_input_received' || event.data.synthetic === true) continue;
    const text = typeof event.data.text === 'string' ? event.data.text : '';
    const recipients = emailSet(text);
    if (recipients.length > 0) sources.push({ id: `user:${event.seq}`, tool: null, recipients });
  }

  const returnsByCall = new Map<string, { effect?: string; tool?: string | null }>();
  for (const event of events) {
    if (event.type !== 'tool_returned') continue;
    const callId = typeof event.data.callId === 'string' ? event.data.callId : '';
    if (!callId) continue;
    returnsByCall.set(callId, {
      effect: typeof event.data.effect === 'string' ? event.data.effect : undefined,
      tool: typeof event.data.tool === 'string' ? event.data.tool : null,
    });
  }
  for (const output of recentToolOutputs(sessionId, { limit: 40 })) {
    const meta = returnsByCall.get(output.callId);
    const tool = output.tool ?? meta?.tool ?? null;
    if (ECHO_TOOL_RE.test(tool ?? '')) continue;
    // Full outputs from writes/sends are confirmations of a payload, not source
    // authority for that payload. Legacy rows without effect metadata remain
    // eligible unless their tool is an explicit echo surface above.
    if (meta?.effect && meta.effect !== 'read' && meta.effect !== 'compute') continue;
    const recipients = emailSet(output.output);
    if (recipients.length > 0) sources.push({ id: output.callId, tool, recipients });
  }
  return sources;
}

/**
 * Deterministic completeness/identity boundary for batch communications.
 * A single-recipient send follows the existing grounding gates. Two or more
 * recipients must co-occur in one trusted read result or real user message;
 * stitching identities across unrelated snippets is refused.
 */
export function evaluateRecipientSetIntegrity(sessionId: string, rawArgs: unknown): RecipientIntegrityResult {
  const recipients = emailSet(rawArgs);
  if (recipients.length < 2) {
    return { action: 'allow', reason: 'single-recipient or no-email payload', recipients };
  }

  let sources: RecipientIntegritySource[];
  try {
    sources = trustedRecipientSources(sessionId);
  } catch {
    return {
      action: 'block',
      reason: 'trusted recipient sources could not be read; multi-recipient sends fail closed',
      recipients,
      unsupportedRecipients: recipients,
    };
  }

  const exact = sources.find((source) => source.recipients.length === recipients.length
    && recipients.every((recipient) => source.recipients.includes(recipient)));
  if (exact) {
    return { action: 'allow', reason: 'outgoing recipient set exactly matches one trusted source', recipients, sourceId: exact.id };
  }
  const covering = sources.find((source) => recipients.every((recipient) => source.recipients.includes(recipient)));
  if (covering) {
    return { action: 'allow', reason: 'every outgoing recipient co-occurs in one trusted source', recipients, sourceId: covering.id };
  }

  const seen = new Set(sources.flatMap((source) => source.recipients));
  const unsupportedRecipients = recipients.filter((recipient) => !seen.has(recipient));
  return {
    action: 'block',
    reason: unsupportedRecipients.length > 0
      ? `${unsupportedRecipients.length} outgoing recipient(s) do not appear in any trusted source`
      : 'the recipients appear only across separate artifacts; no authoritative complete set supports this batch',
    recipients,
    unsupportedRecipients,
  };
}

export class RecipientSetIntegrityError extends Error {
  public readonly toolName: string;
  public readonly recipients: string[];
  public readonly unsupportedRecipients: string[];

  constructor(input: { toolName: string; result: RecipientIntegrityResult }) {
    const unsupported = input.result.unsupportedRecipients ?? [];
    super(
      `RECIPIENT_SET_INTEGRITY_FAILED: refused this multi-recipient ${input.toolName} before approval or send. `
      + `${input.result.reason}. `
      + `Outgoing set: ${input.result.recipients.join(', ')}. `
      + (unsupported.length > 0 ? `Unsupported: ${unsupported.join(', ')}. ` : '')
      + 'Recover by re-reading one authoritative complete roster (use memory_recall_all or the original source/tool output), rebuild the payload directly from that result, and retry. Do not synthesize, autocomplete, or merge recipient names from memory. If no complete source exists, ask the user.',
    );
    this.name = 'RecipientSetIntegrityError';
    this.toolName = input.toolName;
    this.recipients = input.result.recipients;
    this.unsupportedRecipients = unsupported;
  }
}
