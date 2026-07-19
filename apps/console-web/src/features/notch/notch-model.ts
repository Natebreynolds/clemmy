import type { NotchLiveActivity } from '@/lib/live-activity';

/** The three live states the non-meeting notch can render. */
export type NotchLiveState = NotchLiveActivity['state'];

export interface NotchState {
  expanded: boolean;
  activity: NotchLiveActivity;
}

export type NotchAction =
  | { type: 'toggle' }
  | { type: 'expand' }
  | { type: 'collapse' }
  | { type: 'dismiss' }
  | { type: 'set-activity'; activity: NotchLiveActivity };

export interface NotchSurfaceSize {
  width: number;
  height: number;
}

// The dormant native frame surrounds only the Clementine dog and its forgiving
// hit target. The desktop positions this 62pt frame beside the physical notch;
// unlike the old transparent overlay, it stays interactive continuously.
const COLLAPSED_SIZE: NotchSurfaceSize = { width: 62, height: 48 };
// Two expanded heights, no wasted space. Most states are status-only (header +
// copy) and need no bottom action — the header already carries Open/collapse/
// dismiss. Only the approval state adds a "Review & approve" CTA row, so only it
// needs the taller card. Heights fit the exact-size (non-scrolling) window:
//   status-only: header 52 + content padding 26 + copy 56 + 10px island offset ≈ 144
//   with action: + gap 9 + action row 36 ≈ 189.
const EXPANDED_SIZE: NotchSurfaceSize = { width: 392, height: 144 };
const EXPANDED_SIZE_WITH_ACTION: NotchSurfaceSize = { width: 392, height: 190 };
// Voice begins as a tight listening control and grows only when there is content
// worth reading. A fixed tall frame made the initial mic state look unfinished.
const VOICE_LISTENING_SIZE: NotchSurfaceSize = { width: 336, height: 108 };
const VOICE_TRANSCRIPT_SIZE: NotchSurfaceSize = { width: 336, height: 132 };
const VOICE_ERROR_SIZE: NotchSurfaceSize = { width: 336, height: 144 };
const VOICE_RESPONSE_SIZE: NotchSurfaceSize = { width: 336, height: 164 };

export function notchVoiceSurfaceSize(content: {
  hasTranscript: boolean;
  hasResponse: boolean;
  hasError: boolean;
}): NotchSurfaceSize {
  if (content.hasResponse) return VOICE_RESPONSE_SIZE;
  if (content.hasError) return VOICE_ERROR_SIZE;
  if (content.hasTranscript) return VOICE_TRANSCRIPT_SIZE;
  return VOICE_LISTENING_SIZE;
}

export function createInitialActivity(): NotchLiveActivity {
  return { state: 'idle', title: 'Ready', detail: '', needsYouCount: 0, runningCount: 0, updatedAt: '' };
}

export function createInitialNotchState(): NotchState {
  return { expanded: false, activity: createInitialActivity() };
}

export function notchSurfaceSize(state: Pick<NotchState, 'expanded'> & { activity?: NotchLiveActivity }): NotchSurfaceSize {
  if (!state.expanded) return COLLAPSED_SIZE;
  // Only the approval state renders a bottom action row; everything else is
  // status-only and uses the shorter card (no dead space beneath the copy).
  return state.activity?.state === 'approval' ? EXPANDED_SIZE_WITH_ACTION : EXPANDED_SIZE;
}

export function notchReducer(state: NotchState, action: NotchAction): NotchState {
  switch (action.type) {
    case 'toggle':
      return { ...state, expanded: !state.expanded };
    case 'expand':
      return state.expanded ? state : { ...state, expanded: true };
    case 'collapse':
      return state.expanded ? { ...state, expanded: false } : state;
    case 'dismiss':
      return { ...state, expanded: false };
    case 'set-activity':
      return { ...state, activity: action.activity };
  }
}
