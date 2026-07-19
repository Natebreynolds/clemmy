import { clemmy } from './clemmy';

export type NotchBehavior = 'manual' | 'working' | 'always';
export type NotchDisplay = 'pointer' | 'primary';

export interface NotchPreferences {
  enabled: boolean;
  behavior: NotchBehavior;
  autoHideAfterCompletion: boolean;
  promptForDetectedMeetings: boolean;
  shortcut: string;
  preferredDisplay: NotchDisplay;
}

export interface NotchSettingsSnapshot {
  supported: boolean;
  preview: boolean;
  taskDrivenBehaviorAvailable: boolean;
  shortcutManagedByEnvironment: boolean;
  preferences: NotchPreferences;
  runtime: {
    availability: 'loading' | 'ready' | 'unavailable';
    visible: boolean;
    shortcutRegistered: boolean;
    shortcutError?: string;
    clickHelper?: 'starting' | 'ready' | 'degraded' | 'stopped';
    clickHelperError?: string;
    canOpenPreview: boolean;
  };
  meetingCapture?: {
    enabled: boolean;
    sdkAvailable: boolean;
    initialized: boolean;
    recording: boolean;
    lastError?: string;
    capturePhase?: 'idle' | 'prompt' | 'starting' | 'recording' | 'stopping';
    platformSupport?: { supported: boolean; message?: string };
    autoRecord: boolean;
  } | null;
  localMeetingCapture?: {
    recording: boolean;
    sessionId?: string;
    title?: string;
    startedAt?: string;
    stale?: boolean;
  };
}

export interface NotchSettingsMutation {
  ok: boolean;
  error?: string;
  pending?: boolean;
  snapshot: NotchSettingsSnapshot;
}

export type NotchRecallCapability = 'off' | 'unsupported' | 'needs-attention' | 'ready';

export function notchRecallCapability(
  meetingCapture: NotchSettingsSnapshot['meetingCapture'],
): NotchRecallCapability {
  if (!meetingCapture?.enabled) return 'off';
  if (meetingCapture.platformSupport?.supported === false) return 'unsupported';
  if (!meetingCapture.sdkAvailable || !meetingCapture.initialized) return 'needs-attention';
  return 'ready';
}

export function notchRecallCapabilityCopy(
  meetingCapture: NotchSettingsSnapshot['meetingCapture'],
  notchEnabled = true,
): string {
  if (!notchEnabled) {
    return 'Clementine in the notch is off. Turn it on to use online meeting prompts and recording controls from the notch.';
  }
  switch (notchRecallCapability(meetingCapture)) {
    case 'ready':
      return 'Online meeting prompts and recording controls are live. In-person microphone recording is available directly from the notch with Meet.';
    case 'off':
      return 'In-person microphone recording is available from Meet. Turn on online meeting capture from Meetings to also detect Zoom, Google Meet, Microsoft Teams, and Slack Huddles.';
    case 'unsupported':
      return meetingCapture?.platformSupport?.message
        ?? 'Online meeting capture is unavailable on this Mac. In-person recording from the notch is still available.';
    case 'needs-attention':
      return meetingCapture?.lastError
        ? `Online meeting controls need attention: ${meetingCapture.lastError}`
        : 'Online meeting controls need attention. Review meeting capture before relying on prompts or recording controls.';
  }
}

export async function getNotchSettings(): Promise<NotchSettingsSnapshot | null> {
  const method = clemmy()?.notchStatus;
  if (typeof method !== 'function') return null;
  return await method() as NotchSettingsSnapshot;
}

export async function updateNotchSettings(patch: Partial<NotchPreferences>): Promise<NotchSettingsMutation> {
  const method = clemmy()?.notchUpdate;
  if (typeof method !== 'function') throw new Error('Notch settings are available in the Clementine macOS app.');
  return await method(patch) as NotchSettingsMutation;
}

export async function openNotchPreview(): Promise<NotchSettingsMutation> {
  const method = clemmy()?.notchOpen;
  if (typeof method !== 'function') throw new Error('The notch preview is available in the Clementine macOS app.');
  return await method() as NotchSettingsMutation;
}
