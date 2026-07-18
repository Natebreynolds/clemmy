import { randomBytes } from 'node:crypto';

export const CLEMENTINE_LIVE_MOUNT_QUERY_PARAM = 'clemmyLiveMount';
export const CLEMENTINE_LIVE_GENERATION_QUERY_PARAM = 'clemmyLiveGeneration';

export interface ClementineLiveMountIdentity {
  generation: number;
  nonce: string;
}

const MOUNT_NONCE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

export function isValidClementineLiveMountNonce(value: unknown): value is string {
  return typeof value === 'string' && MOUNT_NONCE_PATTERN.test(value);
}

export function isValidClementineLiveMountIdentity(
  value: unknown,
): value is ClementineLiveMountIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Number.isSafeInteger(record.generation)
    && (record.generation as number) > 0
    && isValidClementineLiveMountNonce(record.nonce);
}

export function createClementineLiveMountIdentity(
  previousGeneration: number,
  nonceFactory: () => string = () => randomBytes(24).toString('base64url'),
): ClementineLiveMountIdentity {
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0
      || previousGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid Clementine Live navigation generation');
  }
  const nonce = nonceFactory();
  if (!isValidClementineLiveMountNonce(nonce)) {
    throw new Error('Invalid Clementine Live mount nonce');
  }
  return { generation: previousGeneration + 1, nonce };
}

export function isCurrentClementineLiveMount(
  current: ClementineLiveMountIdentity | null,
  candidate: ClementineLiveMountIdentity,
): boolean {
  return current !== null
    && current.generation === candidate.generation
    && current.nonce === candidate.nonce;
}

export function clementineLiveMountFromUrl(rawUrl: string): ClementineLiveMountIdentity | null {
  try {
    const url = new URL(rawUrl);
    const generation = Number(url.searchParams.get(CLEMENTINE_LIVE_GENERATION_QUERY_PARAM));
    const nonce = url.searchParams.get(CLEMENTINE_LIVE_MOUNT_QUERY_PARAM);
    const candidate = { generation, nonce };
    return isValidClementineLiveMountIdentity(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function clementineLiveUrlForDashboard(
  rawDashboardUrl: string,
  mount: ClementineLiveMountIdentity,
): string {
  if (!isValidClementineLiveMountIdentity(mount)) {
    throw new Error('Invalid Clementine Live mount identity');
  }
  const url = new URL(rawDashboardUrl);
  url.pathname = '/console/notch';
  url.search = '';
  url.hash = '';
  url.searchParams.set(CLEMENTINE_LIVE_MOUNT_QUERY_PARAM, mount.nonce);
  url.searchParams.set(CLEMENTINE_LIVE_GENERATION_QUERY_PARAM, String(mount.generation));
  return url.toString();
}
