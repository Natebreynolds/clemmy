export type NotchPreviewPhase = 'review' | 'working' | 'approval' | 'completed' | 'cancelled' | 'failure';

export type NotchActivityTone = 'complete' | 'active' | 'waiting' | 'attention' | 'success' | 'error';

export type NotchAgentState = 'completed' | 'active' | 'queued';

export interface NotchActivityRow {
  id: string;
  label: string;
  detail: string;
  tone: NotchActivityTone;
}

export interface NotchPreviewFrame {
  phase: NotchPreviewPhase;
  navLabel: string;
  statusLabel: string;
  collapsedSummary: string;
  latestMilestone: string;
  title: string;
  summary: string;
  activities: readonly NotchActivityRow[];
  parentTask?: {
    title: string;
    detail: string;
  };
  agents?: readonly {
    id: string;
    name: string;
    role: string;
    detail: string;
    state: NotchAgentState;
  }[];
  approval?: {
    title: string;
    detail: string;
  };
}

export interface NotchState {
  phase: NotchPreviewPhase;
  expanded: boolean;
  transcript: string;
  playing: boolean;
}

export type NotchAction =
  | { type: 'toggle' }
  | { type: 'dismiss' }
  | { type: 'set-transcript'; transcript: string }
  | { type: 'select-phase'; phase: NotchPreviewPhase }
  | { type: 'advance-demo' }
  | { type: 'autoplay-tick' }
  | { type: 'toggle-play' }
  | { type: 'set-playing'; playing: boolean }
  | { type: 'submit-preview' }
  | { type: 'approve-preview' }
  | { type: 'reject-preview' }
  | { type: 'restart-preview' }
  | {
    type: 'apply-preview';
    phase?: NotchPreviewPhase;
    expanded?: boolean;
    transcript?: string;
    playing?: boolean;
  };

export interface NotchSurfaceSize {
  width: number;
  height: number;
}

export const SAMPLE_TRANSCRIPT =
  'Find 30 minutes for a product review with Maya next week, send the invite, and add the agenda from our launch notes.';

export const DEMO_SEQUENCE: readonly NotchPreviewPhase[] = [
  'review',
  'working',
  'approval',
  'completed',
  'failure',
];

const ALL_PREVIEW_PHASES: readonly NotchPreviewPhase[] = [...DEMO_SEQUENCE, 'cancelled'];

export const NOTCH_PREVIEW_FRAMES: Readonly<Record<NotchPreviewPhase, NotchPreviewFrame>> = {
  review: {
    phase: 'review',
    navLabel: 'Review',
    statusLabel: 'Ready to send',
    collapsedSummary: 'Ready to review',
    latestMilestone: 'Nothing sent',
    title: 'Review your request',
    summary: 'Nothing has been sent. Edit the sample, then preview the handoff.',
    activities: [
      { id: 'review-captured', label: 'Captured a sample request', detail: 'Preview only', tone: 'complete' },
      { id: 'review-waiting', label: 'Waiting for your review', detail: 'Nothing sent', tone: 'waiting' },
    ],
  },
  working: {
    phase: 'working',
    navLabel: 'Working',
    statusLabel: '3 agents working',
    collapsedSummary: '3 agents working',
    latestMilestone: 'Mira is drafting the agenda',
    title: 'Coordinating the product review',
    summary: 'Preview of one parent task coordinating focused agents through observable milestones.',
    parentTask: {
      title: 'Schedule the product review with Maya',
      detail: 'Clementine · parent task · coordinating 3 preview agents',
    },
    agents: [
      {
        id: 'agent-scout',
        name: 'Scout',
        role: 'Calendar researcher',
        detail: 'Found two open windows',
        state: 'completed',
      },
      {
        id: 'agent-mira',
        name: 'Mira',
        role: 'Agenda writer',
        detail: 'Drafting from launch notes',
        state: 'active',
      },
      {
        id: 'agent-piper',
        name: 'Piper',
        role: 'Invite verifier',
        detail: 'Waiting for the agenda',
        state: 'queued',
      },
    ],
    activities: [
      { id: 'working-delegated', label: 'Delegated three focused roles', detail: 'Team started', tone: 'complete' },
      { id: 'working-agenda', label: 'Drafting the launch agenda', detail: 'Latest milestone', tone: 'active' },
    ],
  },
  approval: {
    phase: 'approval',
    navLabel: 'Approval',
    statusLabel: 'Needs your approval',
    collapsedSummary: 'Approval needed',
    latestMilestone: 'Invite is ready to send',
    title: 'Ready to send the invite',
    summary: 'Clementine pauses before the external side effect and names it precisely.',
    approval: {
      title: 'Send calendar invitation to Maya Chen',
      detail: '30 minutes · Product review · next week',
    },
    activities: [
      { id: 'approval-received', label: 'Received your request', detail: 'Just now', tone: 'complete' },
      { id: 'approval-checked', label: 'Found two open times', detail: 'Calendar checked', tone: 'complete' },
      { id: 'approval-waiting', label: 'Waiting to send the invite', detail: 'Approval required', tone: 'attention' },
    ],
  },
  completed: {
    phase: 'completed',
    navLabel: 'Complete',
    statusLabel: 'Done',
    collapsedSummary: 'Product review scheduled',
    latestMilestone: 'Invite sent and verified',
    title: 'Product review scheduled',
    summary: 'Tuesday at 10:30 AM · Invitation sent to Maya · Agenda attached.',
    activities: [
      { id: 'completed-checked', label: 'Checked both calendars', detail: 'Finished', tone: 'complete' },
      { id: 'completed-event', label: 'Created the calendar event', detail: 'Verified', tone: 'complete' },
      { id: 'completed-done', label: 'Completed', detail: 'Invite sent', tone: 'success' },
    ],
  },
  cancelled: {
    phase: 'cancelled',
    navLabel: 'Cancelled',
    statusLabel: 'Not sent',
    collapsedSummary: 'Invite not sent',
    latestMilestone: 'You rejected the action',
    title: 'The invite was cancelled',
    summary: 'You rejected this action. Clementine stopped before sending, and no invitation was created.',
    activities: [
      { id: 'cancelled-checked', label: 'Found two open times', detail: 'Finished', tone: 'complete' },
      { id: 'cancelled-rejected', label: 'You rejected the invitation', detail: 'Action stopped', tone: 'attention' },
      { id: 'cancelled-safe', label: 'Verified no invite was sent', detail: 'Nothing changed', tone: 'success' },
    ],
  },
  failure: {
    phase: 'failure',
    navLabel: 'Failure',
    statusLabel: 'Failed safely',
    collapsedSummary: 'Calendar needs attention',
    latestMilestone: 'Verified no invite was sent',
    title: 'The invite was not sent',
    summary: 'Calendar access expired before the send. Clementine verified that no invitation was created.',
    activities: [
      { id: 'failure-checked', label: 'Checked calendar availability', detail: 'Finished', tone: 'complete' },
      { id: 'failure-auth', label: 'Calendar connection expired', detail: 'Needs attention', tone: 'error' },
      { id: 'failure-safe', label: 'Verified no invite was sent', detail: 'Safe to retry', tone: 'success' },
    ],
  },
};

const COLLAPSED_SIZE: NotchSurfaceSize = { width: 326, height: 46 };

const EXPANDED_SIZES: Readonly<Record<NotchPreviewPhase, NotchSurfaceSize>> = {
  // Keep a small vertical safety margin around the fixed demo chrome. Font
  // rasterization varies slightly between Chromium/browser and packaged macOS
  // builds; the margin prevents the action row from crowding the last activity.
  review: { width: 520, height: 470 },
  working: { width: 520, height: 684 },
  approval: { width: 520, height: 574 },
  completed: { width: 520, height: 506 },
  cancelled: { width: 520, height: 520 },
  failure: { width: 520, height: 520 },
};

/** Autoplay demonstrates one coherent happy path. Terminal and failure-gallery
 * frames never roll into another outcome without an explicit user action. */
export function nextAutoplayPhase(phase: NotchPreviewPhase): NotchPreviewPhase | null {
  switch (phase) {
    case 'review':
      return 'working';
    case 'working':
      return 'approval';
    case 'approval':
      return 'completed';
    case 'completed':
    case 'cancelled':
    case 'failure':
      return null;
  }
}

export function createInitialNotchState(): NotchState {
  return {
    phase: 'review',
    expanded: false,
    transcript: SAMPLE_TRANSCRIPT,
    playing: false,
  };
}

export function notchSurfaceSize(state: Pick<NotchState, 'expanded' | 'phase'>): NotchSurfaceSize {
  return state.expanded ? EXPANDED_SIZES[state.phase] : COLLAPSED_SIZE;
}

export function notchReducer(state: NotchState, action: NotchAction): NotchState {
  switch (action.type) {
    case 'toggle':
      return { ...state, expanded: !state.expanded, playing: state.expanded ? false : state.playing };
    case 'dismiss':
      return { ...state, expanded: false, playing: false };
    case 'set-transcript':
      return { ...state, transcript: action.transcript };
    case 'select-phase':
      return { ...state, phase: action.phase, expanded: true, playing: false };
    case 'advance-demo': {
      const currentIndex = DEMO_SEQUENCE.indexOf(state.phase);
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % DEMO_SEQUENCE.length;
      return { ...state, phase: DEMO_SEQUENCE[nextIndex], expanded: true };
    }
    case 'autoplay-tick': {
      const nextPhase = nextAutoplayPhase(state.phase);
      return nextPhase
        ? { ...state, phase: nextPhase, expanded: true, playing: nextAutoplayPhase(nextPhase) !== null }
        : { ...state, playing: false };
    }
    case 'toggle-play': {
      if (state.playing) return { ...state, playing: false };
      const phase = nextAutoplayPhase(state.phase) ? state.phase : 'review';
      return { ...state, phase, expanded: true, playing: true };
    }
    case 'set-playing': {
      if (!action.playing) return { ...state, playing: false };
      const phase = nextAutoplayPhase(state.phase) ? state.phase : 'review';
      return { ...state, phase, expanded: true, playing: true };
    }
    case 'submit-preview':
      return { ...state, phase: 'working', expanded: true, playing: false };
    case 'approve-preview':
      return { ...state, phase: 'completed', expanded: true, playing: false };
    case 'reject-preview':
      return { ...state, phase: 'cancelled', expanded: true, playing: false };
    case 'restart-preview':
      return { ...state, phase: 'review', expanded: true, playing: false };
    case 'apply-preview':
      return {
        ...state,
        phase: action.phase ?? state.phase,
        expanded: action.expanded ?? state.expanded,
        transcript: action.transcript ?? state.transcript,
        playing: action.playing ?? false,
      };
  }
}

function normalizePhase(value: unknown): NotchPreviewPhase | undefined {
  if (value === 'complete') return 'completed';
  if (value === 'failed') return 'failure';
  if (value === 'canceled' || value === 'rejected') return 'cancelled';
  return ALL_PREVIEW_PHASES.find((phase) => phase === value);
}

/** Convert the deliberately loose native preview payload into a typed action.
 * The bridge is optional and version-skew is expected during Stage 0, so
 * unknown commands are ignored rather than taking down the transparent UI. */
export function previewActionFromBridge(payload: unknown): NotchAction | null {
  if (typeof payload === 'string') {
    const phase = normalizePhase(payload);
    if (phase) return { type: 'select-phase', phase };
    if (payload === 'next') return { type: 'advance-demo' };
    if (payload === 'play') return { type: 'set-playing', playing: true };
    if (payload === 'pause') return { type: 'set-playing', playing: false };
    if (payload === 'toggle') return { type: 'toggle' };
    if (payload === 'dismiss' || payload === 'collapsed') return { type: 'dismiss' };
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  const command = payload as Record<string, unknown>;
  // The native shell remains mounted while its BrowserWindow is hidden. Stop
  // the deterministic preview clock when the tray or global shortcut hides it
  // so background timers cannot advance phases or resize an invisible window.
  if (command.kind === 'shell-state' && command.visible === false) {
    return { type: 'set-playing', playing: false };
  }
  const phase = normalizePhase(command.phase ?? command.state ?? command.preview);
  const expanded = typeof command.expanded === 'boolean' ? command.expanded : undefined;
  const transcript = typeof command.transcript === 'string' ? command.transcript : undefined;
  const playing = typeof command.playing === 'boolean' ? command.playing : undefined;
  if (phase === undefined && expanded === undefined && transcript === undefined && playing === undefined) return null;
  return { type: 'apply-preview', phase, expanded, transcript, playing };
}
