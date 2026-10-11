import type { Router, RequestHandler } from 'express';

export interface NativeVoiceTerminal {
  sessionId: string;
  sourceUserSeq: number;
  status: string;
  kind: string;
  text: string;
  /** Positive proof from the exact committed/source events, never reply prose. */
  ordinaryQuestion?: boolean;
  requiresApp?: boolean;
}

type EventData = Record<string, unknown>;

function record(value: unknown): EventData | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as EventData : null;
}

function hasControlMetadata(value: unknown): boolean {
  const data = record(value);
  if (!data) return false;
  // Presence is enough: malformed control metadata must not fail open.
  return ['liveApprovalControl', 'approvalId', 'approvalInquiry', 'reviewedPlanOwnerControl']
    .some((key) => Object.prototype.hasOwnProperty.call(data, key))
    || ['mobile_approval', 'mobile_approval_confirm', 'mobile_approval_inquiry'].includes(String(data.source ?? ''))
    || data.reason === 'approval_confirmation_required';
}

/** An approval confirmation is also a canonical input/question. Its exact
 * event metadata is the distinction between it and an ordinary clarification. */
export function nativeVoiceControlBoundary(input: {
  sourceUserSeq: number;
  completionData: unknown;
  sourceData: unknown;
  awaitingInputData: readonly unknown[];
}): boolean {
  return hasControlMetadata(input.completionData) || hasControlMetadata(input.sourceData)
    || input.awaitingInputData.some((value) => {
      const data = record(value);
      return data?.sourceUserSeq === input.sourceUserSeq && hasControlMetadata(data);
    });
}

/** Native voice receives only the exact request's committed public terminal.
 * Streaming drafts, child completions, and another turn never become speech. */
export function nativeVoiceStatus(terminal: NativeVoiceTerminal | null) {
  if (!terminal) return { state: 'working' as const, canResumeVoice: false };
  const text = terminal.text.trim().slice(0, 12_000);
  const canContinue = !terminal.requiresApp && Boolean(text) && (
    (terminal.status === 'done' && terminal.kind === 'answer')
    || (terminal.status === 'needs_input' && terminal.kind === 'question' && terminal.ordinaryQuestion === true)
  );
  return {
    state: canContinue ? 'answered' as const : 'needs_app' as const,
    canResumeVoice: canContinue,
    sessionId: terminal.sessionId,
    sourceUserSeq: terminal.sourceUserSeq,
    text: text || 'Open this conversation in Clem to continue.',
  };
}

export function registerNativeVoiceStatus(
  router: Router,
  authenticate: RequestHandler,
  resolve: (deviceId: string, requestId: string) => { sessionId: string; terminal: NativeVoiceTerminal | null } | null,
) {
  router.get('/api/chat/native-voice-status', authenticate, (req, res) => {
    const requestId = req.query.requestId;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) {
      res.status(400).json({ error: 'INVALID_REQUEST_ID' }); return;
    }
    const result = resolve(req.mobileSession!.record.deviceId, requestId);
    res.setHeader('Cache-Control', 'no-store');
    if (!result) { res.status(404).json({ error: 'REQUEST_NOT_FOUND' }); return; }
    res.json({ sessionId: result.sessionId, ...nativeVoiceStatus(result.terminal) });
  });
}
