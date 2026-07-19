import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOTCH_HELPER_PROTOCOL = 1;
const MAX_PROTOCOL_LINE_BYTES = 4_096;
const MAX_RESTARTS = 3;
const READY_HANDSHAKE_TIMEOUT_MS = 2_000;
const STABLE_UPTIME_RESET_MS = 10_000;

export interface NotchClickHelperFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NotchClickHelperConfiguration {
  enabled: boolean;
  state: 'dormant' | 'panel';
  displayId: number;
  /** Display-local top-left coordinates in macOS logical points. */
  frame: NotchClickHelperFrame;
}

export function toDisplayLocalNotchFrame(
  frame: NotchClickHelperFrame,
  displayBounds: Pick<NotchClickHelperFrame, 'x' | 'y'>,
): NotchClickHelperFrame {
  return {
    x: frame.x - displayBounds.x,
    y: frame.y - displayBounds.y,
    width: frame.width,
    height: frame.height,
  };
}

export type NotchClickHelperEvent =
  | { type: 'ready'; protocol: 1 }
  | { type: 'activate'; protocol: 1; seq: number; source: 'view' | 'local' | 'global' }
  | { type: 'hover'; protocol: 1; active: boolean }
  | { type: 'anchor'; protocol: 1; displayId: number; x: number; y: number; topInset: number }
  | { type: 'error'; code: string };

export type NotchClickHelperHealth = 'starting' | 'ready' | 'degraded' | 'stopped';

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
}

export function parseNotchClickHelperEvent(line: string): NotchClickHelperEvent | null {
  if (!line || Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'ready'
      && record.protocol === NOTCH_HELPER_PROTOCOL
      && exactKeys(record, ['protocol', 'type'])) {
    return { type: 'ready', protocol: 1 };
  }
  if (record.type === 'activate'
      && record.protocol === NOTCH_HELPER_PROTOCOL
      && Number.isSafeInteger(record.seq)
      && Number(record.seq) > 0
      && (record.source === 'view' || record.source === 'local' || record.source === 'global')
      && exactKeys(record, ['protocol', 'seq', 'source', 'type'])) {
    return {
      type: 'activate',
      protocol: 1,
      seq: Number(record.seq),
      source: record.source,
    };
  }
  if (record.type === 'hover'
      && record.protocol === NOTCH_HELPER_PROTOCOL
      && typeof record.active === 'boolean'
      && exactKeys(record, ['active', 'protocol', 'type'])) {
    return { type: 'hover', protocol: 1, active: record.active };
  }
  if (record.type === 'anchor'
      && record.protocol === NOTCH_HELPER_PROTOCOL
      && Number.isSafeInteger(record.displayId)
      && Number(record.displayId) >= 0
      && typeof record.x === 'number' && Number.isFinite(record.x)
      && typeof record.y === 'number' && Number.isFinite(record.y)
      && typeof record.topInset === 'number' && Number.isFinite(record.topInset)
      && record.topInset >= 0 && record.topInset <= 160
      && exactKeys(record, ['displayId', 'protocol', 'topInset', 'type', 'x', 'y'])) {
    return {
      type: 'anchor',
      protocol: 1,
      displayId: Number(record.displayId),
      x: record.x,
      y: record.y,
      topInset: record.topInset,
    };
  }
  if (record.type === 'error'
      && typeof record.code === 'string'
      && record.code.length > 0
      && record.code.length <= 80
      && exactKeys(record, ['code', 'type'])) {
    return { type: 'error', code: record.code };
  }
  return null;
}

export function resolveNotchClickHelperPath(input: {
  isPackaged: boolean;
  resourcesPath?: string;
}): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath ?? process.resourcesPath, 'notch-helper', 'ClementineNotchHelper');
  }
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'native',
    'notch-click-helper',
    '.build',
    'ClementineNotchHelper',
  );
}

export class ClementineNotchClickHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private desiredConfiguration: NotchClickHelperConfiguration | null = null;
  private ready = false;
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryScheduledFor: ChildProcessWithoutNullStreams | null = null;
  private lastSequence = 0;

  constructor(private readonly options: {
    executablePath: string;
    onActivate: (event: Extract<NotchClickHelperEvent, { type: 'activate' }>) => void;
    onHover?: (active: boolean) => void;
    onAnchor?: (event: Extract<NotchClickHelperEvent, { type: 'anchor' }>) => void;
    onHealth?: (health: NotchClickHelperHealth, reason?: string) => void;
    onDiagnostic?: (message: string) => void;
  }) {}

  start(): boolean {
    if (process.platform !== 'darwin' || this.child || this.stopping) return false;
    if (!existsSync(this.options.executablePath)) {
      const reason = `native click helper missing: ${this.options.executablePath}`;
      this.options.onDiagnostic?.(reason);
      this.options.onHealth?.('degraded', reason);
      return false;
    }
    this.ready = false;
    this.lastSequence = 0;
    this.options.onHealth?.('starting');
    const child = spawn(this.options.executablePath, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    const stdoutState = { buffer: '' };
    this.child = child;
    this.recoveryScheduledFor = null;
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.child !== child || this.ready || this.stopping) return;
      this.options.onDiagnostic?.('native click helper ready handshake timed out');
      child.kill('SIGTERM');
    }, READY_HANDSHAKE_TIMEOUT_MS);
    this.readyTimer.unref?.();
    child.stdin.on('error', (error) => {
      this.options.onDiagnostic?.(`native click helper stdin error: ${error.message}`);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(child, stdoutState, chunk));
    child.stderr.on('data', (chunk: string) => {
      const detail = chunk.trim().slice(0, 500);
      if (detail) this.options.onDiagnostic?.(`native click helper stderr: ${detail}`);
    });
    child.on('error', (error) => {
      this.options.onDiagnostic?.(`native click helper error: ${error.message}`);
      this.handleChildTermination(child);
    });
    child.on('exit', (code, signal) => {
      this.options.onDiagnostic?.(`native click helper exited: ${code ?? signal ?? 'unknown'}`);
      this.handleChildTermination(child);
    });
    return true;
  }

  configure(configuration: NotchClickHelperConfiguration): void {
    this.desiredConfiguration = {
      enabled: configuration.enabled,
      state: configuration.state,
      displayId: configuration.displayId,
      frame: { ...configuration.frame },
    };
    this.sendConfigurationIfReady();
  }

  /** User-driven retry after the bounded automatic restart budget is spent. */
  retry(): boolean {
    if (this.stopping || this.child) return false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartAttempts = 0;
    this.recoveryScheduledFor = null;
    return this.start();
  }

  stop(): void {
    this.stopping = true;
    this.desiredConfiguration = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearReadyTimer();
    this.clearStableTimer();
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.options.onHealth?.('stopped');
    if (!child) return;
    try { child.stdin.write('{"type":"shutdown"}\n'); } catch { /* process already gone */ }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, 500);
    forceTimer.unref?.();
  }

  private consumeStdout(
    child: ChildProcessWithoutNullStreams,
    state: { buffer: string },
    chunk: string,
  ): void {
    // A terminated child can still have queued stdout callbacks. Never let its
    // ready/activation/anchor messages mutate the replacement's state.
    if (this.child !== child || this.stopping) return;
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_PROTOCOL_LINE_BYTES * 2) {
      this.options.onDiagnostic?.('native click helper exceeded protocol buffer limit');
      child.kill('SIGTERM');
      state.buffer = '';
      return;
    }
    while (true) {
      const newline = state.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      const event = parseNotchClickHelperEvent(line);
      if (!event) {
        this.options.onDiagnostic?.('native click helper sent an invalid protocol message');
        continue;
      }
      if (event.type === 'ready') {
        this.ready = true;
        this.options.onHealth?.('ready');
        this.clearReadyTimer();
        this.clearStableTimer();
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          if (this.child === child && this.ready && !this.stopping) this.restartAttempts = 0;
        }, STABLE_UPTIME_RESET_MS);
        this.stableTimer.unref?.();
        this.sendConfigurationIfReady();
      } else if (event.type === 'activate') {
        if (event.seq <= this.lastSequence) continue;
        this.lastSequence = event.seq;
        this.options.onActivate(event);
      } else if (event.type === 'hover') {
        this.options.onHover?.(event.active);
      } else if (event.type === 'anchor') {
        this.options.onAnchor?.(event);
      } else {
        this.options.onDiagnostic?.(`native click helper reported ${event.code}`);
      }
    }
  }

  private sendConfigurationIfReady(): void {
    if (!this.ready || !this.child || !this.desiredConfiguration) return;
    const payload = JSON.stringify({
      type: 'configure',
      enabled: this.desiredConfiguration.enabled,
      state: this.desiredConfiguration.state,
      displayId: this.desiredConfiguration.displayId,
      frame: this.desiredConfiguration.frame,
    });
    try {
      this.child.stdin.write(`${payload}\n`);
    } catch {
      // The exit handler owns bounded recovery.
    }
  }

  private scheduleRestart(): void {
    if (this.restartAttempts >= MAX_RESTARTS) {
      const reason = `native click helper unavailable after ${MAX_RESTARTS} restarts`;
      this.options.onDiagnostic?.(reason);
      this.options.onHealth?.('degraded', reason);
      return;
    }
    if (this.restartTimer || this.stopping) return;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.recoveryScheduledFor = null;
      this.start();
    }, 250 * this.restartAttempts);
    this.restartTimer.unref?.();
  }

  private handleChildTermination(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child && this.recoveryScheduledFor !== child) return;
    if (this.recoveryScheduledFor === child) return;
    this.recoveryScheduledFor = child;
    if (this.child === child) this.child = null;
    this.ready = false;
    this.clearReadyTimer();
    this.clearStableTimer();
    if (!this.stopping) this.scheduleRestart();
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearStableTimer(): void {
    if (!this.stableTimer) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }
}
