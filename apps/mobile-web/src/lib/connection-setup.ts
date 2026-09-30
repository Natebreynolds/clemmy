import { api } from './api';

export interface ConnectionRequest {
  requestId: string;
  sessionId: string;
  sourceUserSeq: number;
  toolkit: string;
  capability: string;
  continueLabel: string;
  awaitingSignIn: boolean;
  continuationBlocker?: string;
  clientRequestId: string;
}

export interface SetupField {
  name: string;
  label: string;
  description?: string | null;
  default?: string | null;
  isSecret?: boolean;
  required?: boolean;
}

interface SetupMeta {
  name: string;
  fields: SetupField[];
  authScheme: string;
  appUrl?: string | null;
  authHintUrl?: string | null;
  authGuideUrl?: string | null;
}

export type ConnectionForm =
  | { kind: 'credentials'; setup: SetupMeta }
  | { kind: 'details'; setup: SetupMeta }
  | { kind: 'oauth_app'; app: SetupMeta & { accountFields: SetupField[]; callbackUrl: string } };

export type ConnectionAuthorization = ConnectionForm
  | { kind: 'no_auth'; name: string }
  | { kind?: 'authorization'; url?: string; redirectUrl?: string | null };

export interface ConnectionVerification { request: ConnectionRequest | null; ready: boolean; connectionVerified?: true }
export type ConnectionContinuation = (text: string, resume: {
  connectionRequestId: string;
  clientRequestId: string;
}) => Promise<void>;

export function matchingConnectionRequest(request: ConnectionRequest | null, sessionId: string, options: readonly string[]): ConnectionRequest | null {
  return request && request.sessionId === sessionId && request.requestId && request.clientRequestId
    && request.continueLabel && options.includes(request.continueLabel) ? request : null;
}

/** Never turn a returned string into a script URL or a credential-bearing link. */
export function safeConnectionUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function connectionFormFields(form: ConnectionForm) {
  const appFields = form.kind === 'oauth_app' ? form.app.fields.filter((field) => !/redirect/i.test(field.name)) : [];
  const accountFields: SetupField[] = form.kind === 'oauth_app' ? form.app.accountFields
    : form.setup.fields.length || form.kind === 'details' ? form.setup.fields
      : [{ name: 'generic_api_key', label: 'API key', isSecret: true, required: true }];
  return { appFields, accountFields, allFields: [...appFields, ...accountFields] };
}

export function connectionFormBody(form: ConnectionForm, values: Record<string, string>) {
  const { appFields, accountFields } = connectionFormFields(form);
  const pick = (fields: SetupField[]) => Object.fromEntries(fields
    .map((field) => [field.name, (values[field.name] ?? '').trim()])
    .filter(([, value]) => value));
  if (form.kind === 'credentials') return { credentials: pick(accountFields), authScheme: form.setup.authScheme };
  if (form.kind === 'details') return { details: pick(accountFields) };
  return { credentials: pick(appFields), details: pick(accountFields), authScheme: form.app.authScheme };
}

export function createConnectionSetupApi(request: typeof api = api) {
  const context = (pending: ConnectionRequest) => ({ connectionRequestId: pending.requestId, sessionId: pending.sessionId });
  const post = <T>(path: string, body: unknown) => request<T>(path, {
    method: 'POST', cache: 'no-store', body: JSON.stringify(body),
  });
  return {
    load: (sessionId: string) => request<{ request: ConnectionRequest | null }>(
      `/m/api/connection-requests?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' }),
    authorize: (pending: ConnectionRequest) => post<ConnectionAuthorization>(
      `/m/api/composio/toolkits/${encodeURIComponent(pending.toolkit)}/authorize`, context(pending)),
    submit: (pending: ConnectionRequest, form: ConnectionForm, values: Record<string, string>) => post<ConnectionAuthorization | { ok: true }>(
      `/m/api/composio/toolkits/${encodeURIComponent(pending.toolkit)}/${form.kind === 'credentials' ? 'setup-credentials' : form.kind === 'details' ? 'authorize' : 'oauth-app'}`,
      { ...connectionFormBody(form, values), ...context(pending) }),
    verify: (pending: ConnectionRequest) => post<ConnectionVerification>(
      `/m/api/connection-requests/${encodeURIComponent(pending.requestId)}/verify`, { sessionId: pending.sessionId }),
  };
}

export const connectionSetupApi = createConnectionSetupApi();

/** Only a fresh host verdict for this exact paused question can resume it. */
export async function continueVerifiedConnection(
  original: ConnectionRequest, result: ConnectionVerification, options: readonly string[], onContinue: ConnectionContinuation,
): Promise<boolean> {
  const verified = matchingConnectionRequest(result.request, original.sessionId, options);
  if (result.ready !== true || !verified) return false;
  if (verified.requestId !== original.requestId || verified.sourceUserSeq !== original.sourceUserSeq
    || verified.toolkit !== original.toolkit || verified.capability !== original.capability
    || verified.clientRequestId !== original.clientRequestId || verified.continueLabel !== original.continueLabel) return false;
  await onContinue(verified.continueLabel, { connectionRequestId: verified.requestId, clientRequestId: verified.clientRequestId });
  return true;
}
