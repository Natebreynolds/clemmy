import { apiGet } from './api';

/** A finished piece of work from the durable deliverable index — what it is,
 *  where it lives, and the ask + route that produced it. */
export interface DeliveredItem {
  id: number;
  createdAt: string;
  kind: string;
  target: string;
  title: string;
  /** The producing ask + route — powers "Ask Clem about this" and "Run again". */
  why: string;
  sessionId: string | null;
  lane: string | null;
  /** kind='file' only: false when the recorded path no longer exists. */
  stillExists?: boolean;
}

export const listDelivered = (limit = 30) =>
  apiGet<{ items: DeliveredItem[] }>(`/api/console/delivered?limit=${limit}`).then((r) => r.items);
