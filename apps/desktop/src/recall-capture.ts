export type RecallRegion = 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-northeast-1';

export interface RecallCaptureSettings {
  enabled: boolean;
  region: RecallRegion;
  autoRecord: boolean;
  liveTranscript: boolean;
  analyzeOnComplete: boolean;
}

export interface RecallCaptureStatus {
  sdkAvailable: boolean;
  initialized: boolean;
  enabled: boolean;
  recording: boolean;
  currentWindowId?: string;
  lastError?: string;
  lastEvent?: string;
  lastEventAt?: string;
  lastMeeting?: {
    windowId: string;
    platform?: string;
    title?: string;
  };
  /**
   * Per-permission status as reported by the SDK's `permission-status`
   * event. Keys are the permission slugs (`accessibility`, `microphone`,
   * `screen-capture`, etc.); values are the SDK's own strings — usually
   * `granted` | `denied` | `not-determined`. Empty until the SDK fires
   * its first event, so callers should treat missing keys as "unknown."
   */
  permissionStatuses: Record<string, string>;
  /**
   * Snapshot of any meeting windows the SDK has detected during this
   * session that are still considered open. Lets the "Test Connection"
   * button answer "can the SDK currently see my Zoom?" without forcing
   * the user to dig through the logs. Resets on SDK shutdown.
   */
  detectedWindows: Array<{
    windowId: string;
    platform?: string;
    title?: string;
    detectedAt: string;
    recording?: boolean;
  }>;
  settings: RecallCaptureSettings;
}

type RecallPermission = 'accessibility' | 'screen-capture' | 'microphone' | 'system-audio' | 'full-disk-access';

interface RecallSdkWindow {
  id: string;
  title?: string;
  url?: string;
  platform?: string;
}

interface RecallRealtimeEvent {
  window?: RecallSdkWindow;
  event?: string;
  data?: unknown;
}

interface RecallSdk {
  init(options: Record<string, unknown>): Promise<null> | null;
  shutdown(): Promise<null> | null;
  startRecording(config: { windowId: string; uploadToken: string }): Promise<null> | null;
  stopRecording(config: { windowId: string }): Promise<null> | null;
  prepareDesktopAudioRecording(): Promise<string>;
  requestPermission(permission: RecallPermission): Promise<null> | null;
  addEventListener(type: string, callback: (event: unknown) => void): void;
  removeAllEventListeners?(): void;
}

interface RecallCaptureOptions {
  getDaemonBaseUrl(): string;
  getWebhookToken(): string;
  emit(event: Record<string, unknown>): void;
}

const DEFAULT_SETTINGS: RecallCaptureSettings = {
  enabled: false,
  region: 'us-west-2',
  autoRecord: false,
  liveTranscript: false,
  analyzeOnComplete: true,
};

const REGION_URLS: Record<RecallRegion, string> = {
  'us-west-2': 'https://us-west-2.recall.ai',
  'us-east-1': 'https://us-east-1.recall.ai',
  'eu-central-1': 'https://eu-central-1.recall.ai',
  'ap-northeast-1': 'https://ap-northeast-1.recall.ai',
};

function normalizeSettings(settings: Partial<RecallCaptureSettings> | undefined): RecallCaptureSettings {
  const region = settings?.region && settings.region in REGION_URLS ? settings.region : DEFAULT_SETTINGS.region;
  return {
    enabled: settings?.enabled === true,
    region,
    autoRecord: settings?.autoRecord === true,
    liveTranscript: settings?.liveTranscript === true,
    analyzeOnComplete: settings?.analyzeOnComplete !== false,
  };
}

function getNestedString(value: unknown, keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current : undefined;
}

function findWords(value: unknown): Array<{ text?: string; speaker?: string | number }> {
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.words)) return obj.words as Array<{ text?: string; speaker?: string | number }>;
  for (const nested of Object.values(obj)) {
    const found = findWords(nested);
    if (found.length) return found;
  }
  return [];
}

function extractTranscript(event: RecallRealtimeEvent): {
  text: string;
  speaker?: string;
  recordingId?: string;
  isFinal: boolean;
} | null {
  if (event.event !== 'transcript.data') return null;
  const data = event.data;
  const directText = getNestedString(data, ['text'])
    ?? getNestedString(data, ['transcript'])
    ?? getNestedString(data, ['data', 'text'])
    ?? getNestedString(data, ['data', 'transcript']);
  const words = findWords(data);
  const text = (directText ?? words.map((word) => word.text).filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const participantName = getNestedString(data, ['participant', 'name'])
    ?? getNestedString(data, ['data', 'participant', 'name']);
  const speaker = participantName
    ?? (words.find((word) => word.speaker !== undefined)?.speaker !== undefined
      ? `Speaker ${words.find((word) => word.speaker !== undefined)?.speaker}`
      : undefined);
  const recordingId = getNestedString(data, ['recording_id'])
    ?? getNestedString(data, ['recordingId'])
    ?? getNestedString(data, ['data', 'recording_id']);
  return { text, speaker, recordingId, isFinal: true };
}

export class RecallDesktopCapture {
  private settings: RecallCaptureSettings = DEFAULT_SETTINGS;
  private sdk: RecallSdk | null = null;
  private initialized = false;
  private sdkAvailable = false;
  private recording = false;
  private currentWindowId: string | undefined;
  private lastError: string | undefined;
  private lastEvent: string | undefined;
  private lastEventAt: string | undefined;
  private lastMeeting: RecallCaptureStatus['lastMeeting'];
  private permissionStatuses: Record<string, string> = {};
  private detectedWindows = new Map<string, RecallCaptureStatus['detectedWindows'][number]>();

  constructor(private readonly opts: RecallCaptureOptions) {}

  status(): RecallCaptureStatus {
    return {
      sdkAvailable: this.sdkAvailable,
      initialized: this.initialized,
      enabled: this.settings.enabled,
      recording: this.recording,
      currentWindowId: this.currentWindowId,
      lastError: this.lastError,
      lastEvent: this.lastEvent,
      lastEventAt: this.lastEventAt,
      lastMeeting: this.lastMeeting,
      permissionStatuses: { ...this.permissionStatuses },
      detectedWindows: Array.from(this.detectedWindows.values()),
      settings: this.settings,
    };
  }

  private noteEvent(name: string): void {
    this.lastEvent = name;
    this.lastEventAt = new Date().toISOString();
  }

  async configure(settings: Partial<RecallCaptureSettings>): Promise<RecallCaptureStatus> {
    const previousRegion = this.settings.region;
    this.settings = normalizeSettings(settings);
    if (!this.settings.enabled) {
      await this.shutdown();
      return this.status();
    }
    if (this.initialized && previousRegion !== this.settings.region) {
      await this.shutdown();
    }
    await this.initialize();
    return this.status();
  }

  async requestPermissions(): Promise<RecallCaptureStatus> {
    await this.initialize();
    const permissions: RecallPermission[] = ['accessibility', 'microphone', 'screen-capture'];
    for (const permission of permissions) {
      await this.sdk?.requestPermission(permission);
    }
    this.emit('permissions-requested', { permissions });
    return this.status();
  }

  async startManualRecording(): Promise<RecallCaptureStatus> {
    await this.initialize();
    if (!this.sdk) throw new Error('Recall SDK is unavailable.');
    const windowId = await this.sdk.prepareDesktopAudioRecording();
    await this.startRecording(windowId, { platform: 'desktop-audio', title: 'Manual desktop audio recording' });
    return this.status();
  }

  async stopRecording(): Promise<RecallCaptureStatus> {
    if (!this.currentWindowId || !this.sdk) return this.status();
    await this.sdk.stopRecording({ windowId: this.currentWindowId });
    this.emit('recording-stop-requested', { windowId: this.currentWindowId });
    return this.status();
  }

  async shutdown(): Promise<void> {
    if (this.sdk) {
      try {
        this.sdk.removeAllEventListeners?.();
        await this.sdk.shutdown();
      } catch {
        // SDK shutdown should never block app quit.
      }
    }
    this.sdk = null;
    this.initialized = false;
    this.recording = false;
    this.currentWindowId = undefined;
    this.detectedWindows.clear();
    this.permissionStatuses = {};
  }

  /**
   * Diagnostic — drives the dashboard "Test Connection" button. Forces
   * an SDK init if settings.enabled but the SDK hasn't loaded yet,
   * then returns the full status (which includes permissionStatuses
   * and detectedWindows). Errors are captured into lastError instead
   * of throwing so the UI can render them.
   */
  async testConnection(): Promise<RecallCaptureStatus> {
    if (!this.settings.enabled) {
      // The SDK is gated on the user enabling capture; we don't force
      // it to load when the user has explicitly disabled it.
      return this.status();
    }
    try {
      await this.initialize();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.status();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const sdk = await this.loadSdk();
    sdk.addEventListener('meeting-detected', (event) => { void this.onMeetingDetected(event as { window?: RecallSdkWindow }); });
    sdk.addEventListener('recording-started', (event) => { void this.onRecordingStarted(event as { window?: RecallSdkWindow }); });
    sdk.addEventListener('recording-ended', (event) => { void this.onRecordingEnded(event as { window?: RecallSdkWindow }); });
    sdk.addEventListener('meeting-closed', (event) => { this.onMeetingClosed(event as { window?: RecallSdkWindow }); });
    sdk.addEventListener('realtime-event', (event) => { void this.onRealtimeEvent(event as RecallRealtimeEvent); });
    sdk.addEventListener('error', (event) => this.onError(event));
    sdk.addEventListener('permission-status', (event) => this.onPermissionStatus(event as Record<string, unknown>));
    await sdk.init({
      apiUrl: REGION_URLS[this.settings.region],
      acquirePermissionsOnStartup: [],
      restartOnError: true,
    });
    this.sdk = sdk;
    this.initialized = true;
    this.lastError = undefined;
    this.emit('initialized', { region: this.settings.region });
  }

  private async loadSdk(): Promise<RecallSdk> {
    if (this.sdk) return this.sdk;
    try {
      const specifier = '@recallai/desktop-sdk';
      const mod = await import(specifier);
      const sdk = ((mod as { default?: RecallSdk }).default ?? mod) as RecallSdk;
      this.sdkAvailable = true;
      this.sdk = sdk;
      return sdk;
    } catch (error) {
      this.sdkAvailable = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw new Error(`Recall Desktop SDK is not installed or could not load: ${this.lastError}`);
    }
  }

  private async onMeetingDetected(event: { window?: RecallSdkWindow }): Promise<void> {
    const win = event.window;
    if (!win?.id) return;
    this.noteEvent('meeting-detected');
    this.lastMeeting = { windowId: win.id, platform: win.platform, title: win.title };
    this.detectedWindows.set(win.id, {
      windowId: win.id,
      platform: win.platform,
      title: win.title,
      detectedAt: new Date().toISOString(),
      recording: this.recording && this.currentWindowId === win.id,
    });
    this.emit('meeting-detected', this.lastMeeting);
    await this.postDaemon('/api/console/meetings/recall/detected', {
      windowId: win.id,
      platform: win.platform,
      title: win.title,
    });
    if (this.settings.autoRecord && !this.recording) {
      await this.startRecording(win.id, { platform: win.platform, title: win.title });
    }
  }

  private async startRecording(windowId: string, meta: { platform?: string; title?: string } = {}): Promise<void> {
    if (!this.sdk) throw new Error('Recall SDK is unavailable.');
    const upload = await this.postDaemon<{ uploadToken: string; id?: string }>('/api/console/meetings/recall/upload-token', {
      liveTranscript: this.settings.liveTranscript,
    });
    await this.sdk.startRecording({ windowId, uploadToken: upload.uploadToken });
    this.recording = true;
    this.currentWindowId = windowId;
    this.lastMeeting = { windowId, platform: meta.platform, title: meta.title };
    this.emit('recording-start-requested', { windowId, platform: meta.platform, title: meta.title });
    await this.postDaemon('/api/console/meetings/recall/detected', {
      windowId,
      recordingId: upload.id,
      platform: meta.platform,
      title: meta.title,
      status: 'recording',
    });
  }

  private async onRecordingStarted(event: { window?: RecallSdkWindow }): Promise<void> {
    const windowId = event.window?.id ?? this.currentWindowId;
    if (!windowId) return;
    this.recording = true;
    this.currentWindowId = windowId;
    this.noteEvent('recording-started');
    const existing = this.detectedWindows.get(windowId);
    if (existing) {
      this.detectedWindows.set(windowId, { ...existing, recording: true });
    }
    this.emit('recording-started', { windowId });
  }

  private async onRecordingEnded(event: { window?: RecallSdkWindow }): Promise<void> {
    const win = event.window;
    const windowId = win?.id ?? this.currentWindowId;
    if (!windowId) return;
    this.recording = false;
    this.currentWindowId = undefined;
    this.noteEvent('recording-ended');
    const existing = this.detectedWindows.get(windowId);
    if (existing) {
      this.detectedWindows.set(windowId, { ...existing, recording: false });
    }
    const complete = await this.postDaemon('/api/console/meetings/recall/complete', {
      windowId,
      platform: win?.platform ?? this.lastMeeting?.platform,
      title: win?.title ?? this.lastMeeting?.title,
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    this.emit('recording-ended', { windowId, complete });
  }

  private onMeetingClosed(event: { window?: RecallSdkWindow }): void {
    const win = event.window;
    this.noteEvent('meeting-closed');
    if (win?.id) this.detectedWindows.delete(win.id);
    this.emit('meeting-closed', { windowId: win?.id, platform: win?.platform, title: win?.title });
  }

  /**
   * `permission-status` event payload shape varies across SDK versions
   * but always contains a permission name + a granted/denied/etc.
   * status. Normalise to a flat key→value map.
   */
  private onPermissionStatus(event: Record<string, unknown>): void {
    const permission = typeof event.permission === 'string' ? event.permission
      : typeof event.name === 'string' ? event.name
      : undefined;
    const statusValue = typeof event.status === 'string' ? event.status
      : typeof event.state === 'string' ? event.state
      : typeof event.granted === 'boolean' ? (event.granted ? 'granted' : 'denied')
      : undefined;
    if (permission && statusValue) {
      this.permissionStatuses[permission] = statusValue;
    }
    this.emit('permission-status', event);
  }

  private async onRealtimeEvent(event: RecallRealtimeEvent): Promise<void> {
    if (event.event !== 'video_separate_png.data' && event.event !== 'audio_mixed_raw.data') {
      this.emit('realtime-event', { event: event.event, windowId: event.window?.id });
    }
    const transcript = extractTranscript(event);
    const windowId = event.window?.id ?? this.currentWindowId;
    if (!transcript || !windowId) return;
    await this.postDaemon('/api/console/meetings/recall/transcript-event', {
      windowId,
      recordingId: transcript.recordingId,
      event: event.event,
      speaker: transcript.speaker,
      text: transcript.text,
      isFinal: transcript.isFinal,
      timestamp: new Date().toISOString(),
    }).catch((error) => {
      this.emit('transcript-store-failed', { error: error instanceof Error ? error.message : String(error) });
    });
    this.emit('transcript', { windowId, speaker: transcript.speaker, text: transcript.text });
  }

  private onError(event: unknown): void {
    const error = event && typeof event === 'object' && 'message' in event
      ? String((event as { message?: unknown }).message)
      : String(event);
    this.lastError = error;
    this.emit('error', { error });
  }

  private async postDaemon<T = Record<string, unknown>>(pathname: string, body: Record<string, unknown>): Promise<T> {
    const base = this.opts.getDaemonBaseUrl();
    const token = this.opts.getWebhookToken();
    if (!base || !token) throw new Error('Clementine daemon URL/token is unavailable.');
    const url = new URL(pathname, base);
    url.searchParams.set('token', token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error)
        : `${response.status} ${response.statusText}`;
      throw new Error(error);
    }
    return payload as T;
  }

  private emit(type: string, payload: Record<string, unknown> = {}): void {
    this.opts.emit({
      type,
      source: 'recall-meeting-capture',
      at: new Date().toISOString(),
      ...payload,
    });
  }
}
