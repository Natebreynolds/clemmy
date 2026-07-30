import { apiGet } from './api';

/** A piece of FINISHED WORK from the durable deliverable index — grouped
 *  server-side (one card per work session, not per artifact/tool call). */
export interface DeliveredGroup {
  id: number;
  createdAt: string;
  /** Humanized name of the work — never a tool slug or bare filename. */
  title: string;
  /** The ask that produced it. */
  why: string;
  lane: string | null;
  sessionId: string | null;
  url?: string;
  filePath?: string;
  fileStillExists?: boolean;
  artifactCount: number;
  rerunnable: boolean;
}

export const listDelivered = (limit = 12) =>
  apiGet<{ groups: DeliveredGroup[] }>(`/api/console/delivered?limit=${limit}`).then((r) => r.groups);
