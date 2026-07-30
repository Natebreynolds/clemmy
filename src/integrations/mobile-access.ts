/**
 * Mobile Access integration — PIN provisioning + pairing QR for the pinned-TLS
 * direct-app door. The iOS app connects straight to this Mac: no tunnel, no
 * third party in the path. The dashboard's Connect → Mobile panel calls these
 * functions via /api/console/mobile-access/* endpoints.
 */

import os from 'node:os';
import QRCode from 'qrcode';
import { WEBHOOK_HOST, WEBHOOK_PORT } from '../config.js';
import { getDirectAppRuntime } from '../runtime/mobile-ingress.js';
import { createMobilePairingCode } from '../runtime/mobile-pairing.js';
import { setPin, hasPin, readPinMeta } from '../runtime/mobile-pin.js';
import {
  listSessions,
  revokeAllSessions,
  type MobileSessionRecord,
} from '../runtime/mobile-sessions.js';
import { mobileAuthPosture, type MobileAuthPostureGap } from '../runtime/mobile-auth-posture.js';

// ─── PIN rotation ───────────────────────────────────────────────────

export async function rotatePin(pin: string): Promise<{ revokedSessions: number; updatedAt: string }> {
  await setPin(pin);
  const revoked = await revokeAllSessions();
  return { revokedSessions: revoked, updatedAt: new Date().toISOString() };
}

// ─── QR code ────────────────────────────────────────────────────────

export type MobileAccessTargetMode = 'local-preview' | 'direct-app';

export interface MobileAccessHardening {
  /** Weaknesses in the daemon's own auth. Blocking ones prevent the QR. */
  postureGaps?: MobileAuthPostureGap[];
}

export interface MobileAccessTarget {
  url: string;
  mode: MobileAccessTargetMode;
  qrReady: boolean;
  qrBlockedReason?: string;
  hardening?: MobileAccessHardening;
}

export class MobileQrNotReadyError extends Error {
  readonly code = 'MOBILE_QR_NOT_READY';

  constructor(readonly target: MobileAccessTarget) {
    super(target.qrBlockedReason ?? 'Mobile QR is not ready');
  }
}

/**
 * The address a phone on the same network can reach this Mac at. Prefers the
 * primary interfaces (en0/en1 on macOS) so a machine with VPN/virtual
 * interfaces still QRs its real Wi-Fi address.
 */
export function lanIPv4Address(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push({ name, address: info.address });
    }
  }
  if (candidates.length === 0) return null;
  const rank = (name: string): number => {
    if (/^en0$/.test(name)) return 0;
    if (/^en\d+$/.test(name)) return 1;
    if (/^(utun|awdl|bridge|vnic|llw)/.test(name)) return 3;
    return 2;
  };
  candidates.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return candidates[0].address;
}

export function mobileAccessTarget(
  input: {
    /** Test seam — production callers let lanIPv4Address() answer. */
    lanIp?: string | null;
  } = {},
): MobileAccessTarget {
  // If the pinned-TLS door is open, that IS the target: the iOS app connects
  // straight to this Mac and pins the daemon's own certificate — end-to-end
  // encrypted with no third party in the path.
  const directApp = getDirectAppRuntime();
  const lanIp = input.lanIp !== undefined ? input.lanIp : lanIPv4Address();
  if (directApp) {
    const posture = mobileAuthPosture();
    let qrBlockedReason: string | undefined;
    if (!posture.ok) {
      qrBlockedReason = posture.gaps.find((gap) => gap.blocking)?.message
        ?? 'Mobile access is not safe to expose yet.';
    } else if (!lanIp) {
      qrBlockedReason = 'This Mac has no network address a phone could reach. Join a Wi-Fi network and try again.';
    }
    return {
      url: `https://${lanIp ?? '127.0.0.1'}:${directApp.port}/m/`,
      mode: 'direct-app',
      qrReady: posture.ok && Boolean(lanIp),
      qrBlockedReason,
      hardening: { postureGaps: posture.gaps },
    };
  }

  return {
    url: `http://127.0.0.1:${WEBHOOK_PORT}/m/`,
    mode: 'local-preview',
    qrReady: false,
    qrBlockedReason: 'The direct-app door is closed, so a phone cannot reach this Mac. Restart the daemon to open it.',
  };
}

function legacyTargetMode(target: MobileAccessTarget): 'public' | 'local-preview' {
  return target.mode === 'local-preview' ? 'local-preview' : 'public';
}

export async function generateQrSvg(targetInput?: { lanIp?: string | null }): Promise<{
  svg: string;
  targetUrl: string;
  targetMode: 'public' | 'local-preview';
  target: MobileAccessTarget;
  expiresAt: string;
}> {
  const target = mobileAccessTarget({ lanIp: targetInput?.lanIp });
  if (!target.qrReady) {
    throw new MobileQrNotReadyError(target);
  }
  const pairing = await createMobilePairingCode({ targetUrl: target.url });
  const pairUrl = new URL(target.url);
  pairUrl.searchParams.set('pair', pairing.token);
  // The certificate pin travels only inside the QR the user scans on
  // purpose. The iOS app stores it and accepts exactly this cert.
  const fp = getDirectAppRuntime()?.fingerprint;
  if (fp) pairUrl.searchParams.set('fp', fp);
  const svg = await QRCode.toString(pairUrl.toString(), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
  });
  return {
    svg,
    targetUrl: pairUrl.toString(),
    targetMode: legacyTargetMode(target),
    target: { ...target, url: pairUrl.toString() },
    expiresAt: pairing.expiresAt,
  };
}

// ─── aggregate status (single fetch for the panel) ──────────────────

export interface MobileAccessStatusPayload {
  pin: { configured: boolean; updatedAt?: string };
  sessions: Array<Pick<MobileSessionRecord, 'deviceId' | 'deviceLabel' | 'createdAt' | 'lastSeenAt' | 'expiresAt' | 'pushSubscribed'>>;
  webhookBound: { host: string; port: number };
  target: MobileAccessTarget;
  targetUrl?: string;
  targetMode?: 'public' | 'local-preview';
  /** The single derived view every surface renders. */
  setup?: import('./mobile-setup.js').MobileSetupView;
}

export async function getMobileAccessStatusPayload(): Promise<MobileAccessStatusPayload> {
  const pinMeta = readPinMeta();
  const sessions = listSessions().map((row) => ({
    deviceId: row.deviceId,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    pushSubscribed: row.pushSubscribed ?? false,
  }));
  const target = mobileAccessTarget();
  const payload: MobileAccessStatusPayload = {
    pin: { configured: hasPin(), updatedAt: pinMeta?.updatedAt },
    sessions,
    webhookBound: { host: WEBHOOK_HOST, port: WEBHOOK_PORT },
    target,
    targetUrl: target.url,
    targetMode: legacyTargetMode(target),
  };
  // Derived last, from the finished payload, so there is exactly one place
  // that decides "what state is setup in?".
  const { mobileSetupView } = await import('./mobile-setup.js');
  payload.setup = mobileSetupView(payload);
  return payload;
}
