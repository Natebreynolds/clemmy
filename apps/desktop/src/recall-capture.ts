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
  /** Wall-clock ISO timestamp when the current recording started.
   *  Drives the live "MEETING LIVE · 02:14" pill in the dashboard. */
  recordingStartedAt?: string;
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
   * Set when a RECORD MEETING request could NOT start a real meeting
   * recording and we refused to silently fall back to desktop audio. The
   * dashboard surfaces `message` verbatim so the user knows the concrete
   * fix (almost always: grant Screen Recording, then quit + reopen).
   */
  blocked?: {
    reason: 'screen-recording-permission' | 'no-meeting-detected';
    message: string;
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
  /**
   * True when the SDK currently sees an open, non-dismissed meeting
   * window. Drives the dashboard's RECORD MEETING vs RECORD AUDIO
   * label so the user knows whether the primary button will capture
   * their actual meeting or fall back to generic desktop audio.
   */
  hasActiveMeetingWindow: boolean;
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
  // recallai_streaming (mode: prioritize_low_latency) emits interim
  // `transcript.partial_data` as the speaker talks and a finalized
  // `transcript.data` when the utterance settles. We process both: the
  // partials drive the smooth live word-by-word feel in the UI, the
  // finals are what we persist. Anything else (audio/video frames) is
  // not a transcript.
  if (event.event !== 'transcript.data' && event.event !== 'transcript.partial_data') return null;
  const isFinal = event.event === 'transcript.data';
  const data = event.data;
  const directText = getNestedString(data, ['text'])
    ?? getNestedString(data, ['transcript'])
    ?? getNestedString(data, ['data', 'text'])
    ?? getNestedString(data, ['data', 'transcript']);
  const words = findWords(data);
  const text = (directText ?? words.map((word) => word.text).filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Recall.ai's transcript payload shape varies across SDK versions
  // and providers. Names can land under any of:
  //   participant.name / .display_name / .full_name
  //   speaker.name
  //   participant_name (flat)
  // Reaching for all known variants instead of just participant.name
  // fixes "speaker shown as Speaker 0/1/2 even though the meeting has
  // real attendees with names" — observed on 0.4.x Zoom captures.
  const participantName = getNestedString(data, ['participant', 'name'])
    ?? getNestedString(data, ['participant', 'display_name'])
    ?? getNestedString(data, ['participant', 'full_name'])
    ?? getNestedString(data, ['speaker', 'name'])
    ?? getNestedString(data, ['speaker', 'display_name'])
    ?? getNestedString(data, ['participant_name'])
    ?? getNestedString(data, ['data', 'participant', 'name'])
    ?? getNestedString(data, ['data', 'participant', 'display_name'])
    ?? getNestedString(data, ['data', 'speaker', 'name'])
    ?? getNestedString(data, ['data', 'participant_name']);
  const wordSpeaker = words.find((word) => word.speaker !== undefined)?.speaker;
  const speaker = participantName
    ?? (wordSpeaker !== undefined ? `Speaker ${wordSpeaker}` : undefined);
  const recordingId = getNestedString(data, ['recording_id'])
    ?? getNestedString(data, ['recordingId'])
    ?? getNestedString(data, ['data', 'recording_id']);
  return { text, speaker, recordingId, isFinal };
}

export class RecallDesktopCapture {
  private settings: RecallCaptureSettings = DEFAULT_SETTINGS;
  private sdk: RecallSdk | null = null;
  private initialized = false;
  private sdkAvailable = false;
  private recording = false;
  private currentWindowId: string | undefined;
  private currentRecordingId: string | undefined;
  private lastError: string | undefined;
  private lastEvent: string | undefined;
  private lastEventAt: string | undefined;
  private lastMeeting: RecallCaptureStatus['lastMeeting'];
  private permissionStatuses: Record<string, string> = {};
  private detectedWindows = new Map<string, RecallCaptureStatus['detectedWindows'][number]>();
  // Windows we've already prompted the user about during this session.
  // Prevents the UI from re-firing the "record this meeting?" banner
  // every time the SDK re-detects the same Zoom window (which it does
  // every few seconds while the window is open).
  private promptedWindows = new Set<string>();
  // Windows the user explicitly dismissed via the recording pill ×.
  // While a windowId is in this set, autoRecord skips it — otherwise
  // the SDK's repeating meeting-detected events would re-auto-record
  // it within seconds of the dismiss, producing a pill the user can
  // never get rid of. Cleared when the SDK fires meeting-closed for
  // that window (i.e. they really closed Zoom/Meet/Teams).
  private userDismissedWindows = new Set<string>();
  // Permission slugs we've already asked the SDK to request during this
  // session. The SDK's native dialogs are sticky — once shown, asking
  // again is a no-op for "denied" but also produces no useful signal.
  // We track this so we don't spam requests on every meeting-detected.
  private requestedPermissions = new Set<RecallPermission>();
  // Wall-clock start so the live UI can render an elapsed-time pill
  // without recomputing from the SDK's recording-started event.
  private recordingStartedAt: string | undefined;
  private completedRecordingKeys = new Set<string>();

  constructor(private readonly opts: RecallCaptureOptions) {}

  status(): RecallCaptureStatus {
    // Defense-in-depth: if the active window is one the user dismissed,
    // report not-recording to the dashboard truth reconciler regardless
    // of what this.recording happens to say. Without this, a stray SDK
    // event could flip recording back to true a few ms after dismiss
    // and the pill would reappear on the next 5s reconcile tick.
    const dismissedActive = Boolean(
      this.currentWindowId && this.userDismissedWindows.has(this.currentWindowId),
    );
    return {
      sdkAvailable: this.sdkAvailable,
      initialized: this.initialized,
      enabled: this.settings.enabled,
      recording: this.recording && !dismissedActive,
      recordingStartedAt: dismissedActive ? undefined : this.recordingStartedAt,
      currentWindowId: dismissedActive ? undefined : this.currentWindowId,
      lastError: this.lastError,
      lastEvent: this.lastEvent,
      lastEventAt: this.lastEventAt,
      lastMeeting: this.lastMeeting,
      permissionStatuses: { ...this.permissionStatuses },
      detectedWindows: Array.from(this.detectedWindows.values()).map((w) => (
        this.userDismissedWindows.has(w.windowId) ? { ...w, recording: false } : w
      )),
      hasActiveMeetingWindow: this.pickActiveMeetingWindow() !== undefined,
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

  /**
   * The "RECORD MEETING" path the dashboard's primary button uses.
   * If the SDK has an open meeting window (Zoom/Meet/Teams) it records
   * THAT window — per-participant transcript + real title.
   *
   * It does NOT fall back to generic desktop audio when no window is
   * found. That silent fallback was the trap: with Screen Recording
   * permission missing the SDK can't SEE the meeting window, so the
   * button quietly recorded meeting-less desktop audio (no transcript,
   * recall.ai 404s the upload) and never told the user the real fix.
   * Instead we report a `blocked` reason — almost always "grant Screen
   * Recording" — so the dashboard can guide the user. Deliberate
   * in-person audio capture stays available via `startManualRecording()`
   * (an explicit, separate "Record desktop audio" action).
   */
  async recordActiveMeeting(): Promise<RecallCaptureStatus> {
    await this.initialize();
    const windowId = this.pickActiveMeetingWindow();
    if (windowId) {
      return this.recordDetectedWindow(windowId);
    }
    // No meeting window — surface WHY instead of silently recording audio.
    // Screen Recording is what lets the SDK detect/capture meeting windows;
    // if it's not granted, that's the cause ~every time after an app update.
    const screen = this.permissionStatuses['screen-capture'];
    const needsPermission = !screen || screen !== 'granted';
    const blocked: NonNullable<RecallCaptureStatus['blocked']> = needsPermission
      ? {
        reason: 'screen-recording-permission',
        message:
          'Clementine needs Screen Recording permission to record meetings. Open System Settings → '
          + 'Privacy & Security → Screen Recording, turn on Clementine, then QUIT and reopen Clementine. '
          + '(Microphone and Accessibility should be on too.)',
      }
      : {
        reason: 'no-meeting-detected',
        message:
          'No meeting window detected. Open your Zoom, Google Meet, or Teams window, then click RECORD '
          + 'MEETING. For an in-person meeting with no window, use “Record desktop audio” in Settings → Meetings.',
      };
    this.lastError = blocked.message;
    this.emit('recording-blocked', {
      reason: blocked.reason,
      message: blocked.message,
      permission: 'screen-capture',
      permissionStatuses: { ...this.permissionStatuses },
    });
    return { ...this.status(), blocked };
  }

  /**
   * Newest open detected meeting window the user hasn't dismissed, or
   * undefined if none. "Open" = still in detectedWindows (cleared on
   * meeting-closed). Used to decide whether RECORD MEETING records a
   * real meeting or falls back to desktop audio.
   */
  private pickActiveMeetingWindow(): string | undefined {
    let best: { windowId: string; detectedAt: string } | undefined;
    for (const win of this.detectedWindows.values()) {
      if (this.userDismissedWindows.has(win.windowId)) continue;
      if (!best || (win.detectedAt || '') > best.detectedAt) {
        best = { windowId: win.windowId, detectedAt: win.detectedAt || '' };
      }
    }
    return best?.windowId;
  }

  /** Whether the SDK currently sees an open, non-dismissed meeting
   *  window. Lets the dashboard label the button RECORD MEETING vs
   *  RECORD AUDIO without reaching into private state. */
  hasActiveMeetingWindow(): boolean {
    return this.pickActiveMeetingWindow() !== undefined;
  }

  async stopRecording(): Promise<RecallCaptureStatus> {
    // Clear LOCAL state up front, regardless of SDK echo.
    //
    // Previously this method waited for the Recall SDK to fire its own
    // 'recording-ended' event (which runs onRecordingEnded → sets
    // this.recording = false). If the SDK never fires that event —
    // because the recording never actually started, the SDK is in a
    // weird state, or the user is clicking dismiss on a stale pill —
    // this.recording stayed true forever, the truth reconciler in the
    // dashboard kept re-showing the pill every 5s, and the user could
    // never dismiss it. Clear state synchronously so a dismiss is
    // ALWAYS effective; if the SDK later fires recording-ended too,
    // onRecordingEnded becomes a no-op repeat.
    const windowId = this.currentWindowId;
    const recordingId = this.currentRecordingId;
    const startedAt = this.recordingStartedAt;
    const platform = this.lastMeeting?.platform;
    const title = this.lastMeeting?.title;
    this.recording = false;
    this.recordingStartedAt = undefined;
    this.currentRecordingId = undefined;
    if (windowId) {
      const existing = this.detectedWindows.get(windowId);
      if (existing) {
        this.detectedWindows.set(windowId, { ...existing, recording: false });
      }
      // Remember the user dismissed THIS window so autoRecord doesn't
      // immediately re-fire on the next meeting-detected event. Cleared
      // in onMeetingClosed when the meeting window actually closes.
      this.userDismissedWindows.add(windowId);
    }
    this.currentWindowId = undefined;

    if (windowId) {
      if (this.sdk) {
        try {
          await this.sdk.stopRecording({ windowId });
        } catch {
          // SDK may have already stopped or never had this window —
          // either way our local state is correct now. Don't bubble.
        }
      }
      const complete = await this.completeRecording({
        windowId,
        recordingId,
        platform,
        title,
        startedAt,
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      this.emit('recording-ended', {
        windowId,
        recordingId,
        platform,
        title,
        startedAt,
        endedAt: new Date().toISOString(),
        complete,
        source: 'stop-recording',
      });
      this.emit('recording-stop-requested', { windowId });
    }
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
    this.currentRecordingId = undefined;
    this.recordingStartedAt = undefined;
    this.detectedWindows.clear();
    this.userDismissedWindows.clear();
    this.promptedWindows.clear();
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

    // The SDK re-fires this event repeatedly while the meeting window
    // stays open. Only act once per window per session — the daemon
    // detection write, the prompt event, and the permission auto-
    // request should all be idempotent.
    const alreadySeen = this.detectedWindows.has(win.id);

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

    if (!alreadySeen) {
      await this.postDaemon('/api/console/meetings/recall/detected', {
        windowId: win.id,
        platform: win.platform,
        title: win.title,
      }).catch(() => { /* detection write is best-effort */ });

      // Recall capture is useless without screen-capture + system-
      // audio on macOS. Auto-trigger the SDK's native permission
      // dialogs the first time a meeting is detected so the user
      // doesn't have to find the REQUEST PERMISSIONS button in
      // settings before recording becomes possible.
      void this.requestMissingPermissions();
    }

    if (this.recording) return;

    // The user previously dismissed the pill for this window — respect
    // that. autoRecord won't refire until the meeting actually closes.
    if (this.userDismissedWindows.has(win.id)) return;

    if (this.settings.autoRecord) {
      try {
        await this.startRecording(win.id, { platform: win.platform, title: win.title });
        return;
      } catch (err) {
        // Auto-record failed (no API key, network, daemon unreachable).
        // Capture the reason so the UI can show it, then fall through
        // to the prompt path so the user still sees something — they
        // can retry by clicking RECORD.
        this.lastError = err instanceof Error ? err.message : String(err);
        this.emit('error', { error: this.lastError, phase: 'auto-record' });
      }
    }

    // autoRecord is off (or auto-record failed) — surface a single
    // per-window prompt so the dashboard can offer "Record this
    // meeting? · Always record · Not this time" without forcing the
    // user to dig through settings.
    if (!this.promptedWindows.has(win.id)) {
      this.promptedWindows.add(win.id);
      this.emit('meeting-prompt-required', {
        windowId: win.id,
        platform: win.platform,
        title: win.title,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Trigger the SDK's permission dialogs for anything we know we'll
   * need but haven't been granted yet. Idempotent — once a permission
   * has been requested in this session we don't re-fire (the OS-level
   * dialog won't re-appear anyway, and we'd just spam SDK events).
   */
  private async requestMissingPermissions(): Promise<void> {
    if (!this.sdk) return;
    // Order matters: accessibility is required for window detection
    // (the user already has it if they got this far), then the two
    // critical recording permissions.
    const required: RecallPermission[] = ['screen-capture', 'system-audio', 'microphone'];
    const requested: RecallPermission[] = [];
    for (const perm of required) {
      if (this.requestedPermissions.has(perm)) continue;
      const current = this.permissionStatuses[perm];
      if (current === 'granted') continue;
      this.requestedPermissions.add(perm);
      try {
        await this.sdk.requestPermission(perm);
        requested.push(perm);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (requested.length > 0) {
      this.emit('permissions-requested', { permissions: requested, reason: 'meeting-detected' });
    }
  }

  /**
   * Public entry point for the dashboard prompt's "Record" button.
   * Starts recording against a specific window id the SDK has already
   * detected (vs `startManualRecording()` which spins up a generic
   * desktop-audio capture not tied to any window).
   */
  async recordDetectedWindow(windowId: string): Promise<RecallCaptureStatus> {
    await this.initialize();
    const existing = this.detectedWindows.get(windowId);
    await this.startRecording(windowId, {
      platform: existing?.platform,
      title: existing?.title,
    });
    return this.status();
  }

  /**
   * Public entry point for the "Always record" prompt button.
   * Persists the autoRecord toggle so future meetings are picked up
   * automatically, then immediately records the supplied window.
   *
   * "Persists" means writing through the daemon's settings endpoint
   * (which owns the canonical recall-settings.json file). Updating
   * only this.settings would be lost on the next daemon restart.
   */
  async enableAutoRecordAndRecord(windowId: string): Promise<RecallCaptureStatus> {
    this.settings = { ...this.settings, autoRecord: true };
    // Best-effort: if the daemon isn't reachable for some reason we
    // still want the user's click to record the current meeting, so
    // we don't await this. Worst case the toggle reverts after a
    // daemon restart and the user re-confirms once.
    void this.postDaemon('/api/console/meetings/recall/settings', {
      ...this.settings,
      autoRecord: true,
    }, 'PATCH').catch((err) => {
      this.emit('settings-persist-failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return this.recordDetectedWindow(windowId);
  }

  private async startRecording(windowId: string, meta: { platform?: string; title?: string } = {}): Promise<void> {
    if (!this.sdk) throw new Error('Recall SDK is unavailable.');
    const upload = await this.postDaemon<{ uploadToken: string; id?: string }>('/api/console/meetings/recall/upload-token', {
      liveTranscript: this.settings.liveTranscript,
    });
    await this.sdk.startRecording({ windowId, uploadToken: upload.uploadToken });
    this.recording = true;
    this.currentWindowId = windowId;
    this.currentRecordingId = upload.id;
    this.recordingStartedAt = new Date().toISOString();
    this.lastMeeting = { windowId, platform: meta.platform, title: meta.title };
    this.emit('recording-start-requested', {
      windowId,
      platform: meta.platform,
      title: meta.title,
      recordingId: upload.id,
      startedAt: this.recordingStartedAt,
    });
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
    // The SDK can re-fire recording-started for a window we previously
    // told it to stop on (race between sdk.stopRecording() resolving
    // and the next event tick, or the SDK retrying after restartOnError).
    // If the user dismissed the pill for this window, ignore the event —
    // calling sdk.stopRecording again is harmless, and refusing to flip
    // our local recording flag back to true is what makes the dismiss
    // actually stick.
    if (this.userDismissedWindows.has(windowId)) {
      try { await this.sdk?.stopRecording({ windowId }); } catch { /* best-effort */ }
      this.noteEvent('recording-started-ignored');
      return;
    }
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
    const startedAt = this.recordingStartedAt;
    const recordingId = this.currentRecordingId;
    this.recording = false;
    this.currentWindowId = undefined;
    this.currentRecordingId = undefined;
    this.recordingStartedAt = undefined;
    this.noteEvent('recording-ended');
    const existing = this.detectedWindows.get(windowId);
    if (existing) {
      this.detectedWindows.set(windowId, { ...existing, recording: false });
    }
    // Same window may host another meeting later — clear the
    // already-prompted flag so the prompt fires on the next detection.
    this.promptedWindows.delete(windowId);
    const complete = await this.completeRecording({
      windowId,
      recordingId,
      platform: win?.platform ?? this.lastMeeting?.platform,
      title: win?.title ?? this.lastMeeting?.title,
      startedAt,
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ('duplicate' in complete && complete.duplicate === true) return;
    this.emit('recording-ended', {
      windowId,
      recordingId,
      platform: win?.platform ?? this.lastMeeting?.platform,
      title: win?.title ?? this.lastMeeting?.title,
      startedAt,
      endedAt: new Date().toISOString(),
      complete,
    });
  }

  private onMeetingClosed(event: { window?: RecallSdkWindow }): void {
    const win = event.window;
    this.noteEvent('meeting-closed');
    if (win?.id) {
      this.detectedWindows.delete(win.id);
      // Once the meeting actually closes, drop the dismiss flag so the
      // next meeting in this window auto-records normally.
      this.userDismissedWindows.delete(win.id);
      this.promptedWindows.delete(win.id);
    }
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

    // Interim (partial) segments drive the live UI only — emit them as a
    // transient `transcript-partial` so the live card can show a rolling
    // line that gets replaced when the final lands. We deliberately do
    // NOT persist partials: they'd bloat the stored transcript with
    // near-duplicate fragments and waste tokens in the post-meeting
    // analyzer. Only finalized `transcript.data` is written to disk.
    if (!transcript.isFinal) {
      this.emit('transcript-partial', { windowId, speaker: transcript.speaker, text: transcript.text });
      return;
    }

    await this.postDaemon('/api/console/meetings/recall/transcript-event', {
      windowId,
      recordingId: transcript.recordingId ?? this.currentRecordingId,
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

  private async completeRecording(input: {
    windowId: string;
    recordingId?: string;
    platform?: string;
    title?: string;
    startedAt?: string;
  }): Promise<Record<string, unknown>> {
    const keys = [input.recordingId, input.windowId].filter((value): value is string => Boolean(value));
    if (keys.some((key) => this.completedRecordingKeys.has(key))) {
      return { skipped: true, duplicate: true };
    }
    const complete = await this.postDaemon<Record<string, unknown>>('/api/console/meetings/recall/complete', {
      windowId: input.windowId,
      recordingId: input.recordingId,
      platform: input.platform,
      title: input.title,
      startedAt: input.startedAt,
    });
    for (const key of keys) this.completedRecordingKeys.add(key);
    return complete;
  }

  private onError(event: unknown): void {
    const error = event && typeof event === 'object' && 'message' in event
      ? String((event as { message?: unknown }).message)
      : String(event);
    this.lastError = error;
    this.emit('error', { error });
  }

  private async postDaemon<T = Record<string, unknown>>(pathname: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
    const base = this.opts.getDaemonBaseUrl();
    const token = this.opts.getWebhookToken();
    if (!base || !token) throw new Error('Clementine daemon URL/token is unavailable.');
    const url = new URL(pathname, base);
    url.searchParams.set('token', token);
    const response = await fetch(url, {
      method,
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
