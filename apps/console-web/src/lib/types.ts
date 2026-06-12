/** Shared API DTOs mirrored from the daemon (kept loose where shapes vary). */

export interface HarnessEvent {
  seq: number;
  id?: string;
  turn: number;
  role: string;
  type: string;
  createdAt?: number | string;
  data?: Record<string, unknown>;
}

export interface ChatPostResult {
  sessionId: string;
  streamUrl: string;
  status: string; // started | planning | resuming | new-pending | cancelled
  mode: string;
  sinceSeq?: number;
}

/** A "Needs you" / "Working now" / "Recent" row from the command center. */
export interface CommandCenterItem {
  kind?: string;
  title?: string;
  meta?: string;
  panel?: string;
  urgency?: string;
  approvalKind?: 'runtime' | 'harness';
  approvalId?: string;
  targetSessionId?: string;
  /** Backing notification id for needs-attention cards — deep-links to the
   *  Inbox Notifications tab. */
  notifId?: string;
  /** When present the card shows a dismiss (X) button routed to
   *  POST /api/console/inbox/dismiss. */
  dismissKind?: 'checkin' | 'plan' | 'proposal' | 'notif';
  dismissId?: string;
}

export interface CommandCenter {
  presence?: { status?: string; label?: string; awayMessage?: string; mode?: string };
  counts?: Record<string, number>;
  needsYou?: CommandCenterItem[];
  workingNow?: CommandCenterItem[];
  recentCompleted?: CommandCenterItem[];
  memory?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
  focus?: unknown;
}

export interface AttachResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  chars?: number;
}
