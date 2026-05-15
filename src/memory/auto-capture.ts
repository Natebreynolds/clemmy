import type { ConsolidatedFactKind } from './db.js';
import { rememberFact, type ConsolidatedFact } from './facts.js';
import { saveUserProfile, type UserProfile } from '../runtime/user-profile.js';

export interface AutoMemoryCandidate {
  kind: ConsolidatedFactKind;
  content: string;
  reason: string;
}

export interface AutoCaptureResult {
  candidates: AutoMemoryCandidate[];
  facts: ConsolidatedFact[];
  profilePatch?: Record<string, unknown>;
  profile?: UserProfile;
}

const PROJECT_TERMS = /\b(clementine|clemmy|agent|assistant|dashboard|discord|composio|memory|workflow|autonom(?:y|ous)|setup|install|mcp|oauth|keychain|electron|tooling|project)\b/i;
const PROJECT_REQUIREMENT_CUES = /\b(should|needs?|must|has to|have to|main goal|north star|goal|i want|i need|we need|make sure|be able to|easy to|full autonomous|proactive|persistent|long-running|long lasting)\b/i;
const FEEDBACK_CUES = /\b(i (?:do not|don'?t) like|i hate|i would rather|i prefer|instead of|from now on|please (?:always|never|don'?t|do not)|\balways\b|\bnever\b|\btoo noisy\b|\bnot helpful\b)\b/i;
const CONNECTED_APP_TERMS = /\b(composio|outlook|gmail|google calendar|calendar|slack|notion|github|linear|asana|salesforce|hubspot|drive|docs|sheets)\b/i;
const CONNECTED_APP_CUES = /\b(i|we|the agent|users?)\s+(?:use|uses|have|has|need|needs|want|wants|connect|connects|access|auth|authenticate|oauth)\b/i;

const LOW_SIGNAL = /^(approve|approved|reject|rejected|yes|no|ok|okay|cool|perfect|nice|thanks|thank you|lets do it|let'?s do it|keep going|continue|great job|sounds good)[.!?]*$/i;

function clean(value: string, maxChars = 260): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, maxChars);
}

function addCandidate(candidates: AutoMemoryCandidate[], candidate: AutoMemoryCandidate): void {
  const content = clean(candidate.content);
  if (!content || content.length < 12) return;
  const key = `${candidate.kind}:${content.toLowerCase()}`;
  if (candidates.some((entry) => `${entry.kind}:${entry.content.toLowerCase()}` === key)) return;
  candidates.push({ ...candidate, content });
}

function extractPreferredName(message: string): string | undefined {
  const match = message.match(/\b(?:call me|you can call me|my name is)\s+([A-Za-z][A-Za-z0-9 ._-]{1,50})/i);
  if (!match) return undefined;
  return clean(match[1].split(/[.!?,;\n]/)[0] ?? '', 80);
}

export function extractProfilePatchFromMessage(message: string): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  const preferredName = extractPreferredName(message);
  if (preferredName) patch.preferredName = preferredName;

  if (/\b(skip the recap|keep (?:it )?(?:short|concise)|be concise|terse|less detail|don'?t overexplain|do not overexplain|no preamble)\b/i.test(message)) {
    patch.communicationTone = 'terse';
  } else if (/\b(be thorough|go deep|walk me through|explain in detail|more detail|give me the full context)\b/i.test(message)) {
    patch.communicationTone = 'verbose';
  }

  if (/\b(casual tone|be casual|less formal)\b/i.test(message)) {
    patch.formality = 'casual';
  } else if (/\b(formal tone|be formal)\b/i.test(message)) {
    patch.formality = 'formal';
  } else if (/\b(professional tone|keep it professional)\b/i.test(message)) {
    patch.formality = 'professional';
  }

  if (/\b(notify sparingly|don'?t ping me|do not ping me|fewer check-?ins|less noisy|too noisy)\b/i.test(message)) {
    patch.urgencyTolerance = 'low';
  } else if (/\b(keep me updated|frequent updates|proactive check-?ins|check in often|tell me as you go)\b/i.test(message)) {
    patch.urgencyTolerance = 'high';
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function extractAutoMemoryCandidates(message: string, maxCandidates = 3): AutoMemoryCandidate[] {
  const text = clean(message, 900);
  if (!text || LOW_SIGNAL.test(text)) return [];

  const candidates: AutoMemoryCandidate[] = [];

  if (FEEDBACK_CUES.test(text)) {
    const kind: ConsolidatedFactKind = PROJECT_TERMS.test(text) ? 'feedback' : 'user';
    addCandidate(candidates, {
      kind,
      content: kind === 'feedback' ? `Standing product feedback: ${text}` : `User preference: ${text}`,
      reason: 'explicit user preference or feedback',
    });
  }

  if (PROJECT_TERMS.test(text) && PROJECT_REQUIREMENT_CUES.test(text)) {
    addCandidate(candidates, {
      kind: 'project',
      content: `Clementine requirement: ${text}`,
      reason: 'project requirement signal',
    });
  }

  if (CONNECTED_APP_TERMS.test(text) && CONNECTED_APP_CUES.test(text)) {
    addCandidate(candidates, {
      kind: 'reference',
      content: `Connected-app context: ${text}`,
      reason: 'connected app access or setup signal',
    });
  }

  if (candidates.length === 0 && /\bremember (?:that|this|my|i|we)\b/i.test(text)) {
    addCandidate(candidates, {
      kind: 'user',
      content: `User explicitly asked Clementine to remember: ${text}`,
      reason: 'explicit remember request',
    });
  }

  return candidates.slice(0, maxCandidates);
}

export function captureInteractionSignals(input: {
  message: string;
  sessionId?: string;
  maxFacts?: number;
}): AutoCaptureResult {
  const candidates = extractAutoMemoryCandidates(input.message, input.maxFacts ?? 3);
  const facts: ConsolidatedFact[] = [];

  for (const candidate of candidates) {
    try {
      facts.push(rememberFact({
        kind: candidate.kind,
        content: candidate.content,
        sessionId: input.sessionId,
        score: 1.2,
      }));
    } catch {
      // Memory capture should never block the chat turn.
    }
  }

  const profilePatch = extractProfilePatchFromMessage(input.message);
  let profile: UserProfile | undefined;
  if (profilePatch) {
    try {
      profile = saveUserProfile(profilePatch);
    } catch {
      // Profile adaptation is opportunistic, not critical path.
    }
  }

  return {
    candidates,
    facts,
    profilePatch,
    profile,
  };
}
