/** A widget URL selects a screen. Only a consumed native action may start voice. */
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
interface VoiceLaunchReceipt { requestId: string; navigationId: string; ok: boolean }
const attempted = new Set<string>();
const waiting = new Map<string, { navigationId: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

/** Retains an already consumed action while its exact foreground chat loads. */
export class VoiceLaunchGate {
  private claims = new Map<string, { scope: string; at: number; used: boolean }>();

  evaluate(id: string, scope: string, state: 'preparing' | 'ready' | 'blocked' | 'hidden', now = Date.now()): 'wait' | 'start' | 'refuse' | 'used' {
    let claim = this.claims.get(id);
    if (!claim) { claim = { scope, at: now, used: false }; this.claims.set(id, claim); }
    if (claim.used) return 'used';
    if (claim.scope !== scope || state === 'blocked' || state === 'hidden' || now - claim.at > 15_000 || now < claim.at) {
      claim.used = true;
      return 'refuse';
    }
    if (state === 'preparing') return 'wait';
    claim.used = true;
    return 'start';
  }
}

export function consumeWidgetVoiceLaunch(navigationId: string): Promise<boolean> {
  if (!UUID.test(navigationId) || attempted.has(navigationId)) return Promise.resolve(false);
  attempted.add(navigationId);
  const handler = window.webkit?.messageHandlers?.clemWidgetVoiceLaunch;
  if (!handler) return Promise.resolve(false);
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { waiting.delete(requestId); resolve(false); }, 6000);
    waiting.set(requestId, { navigationId, resolve, timer });
    try { handler.postMessage({ requestId, navigationId }); }
    catch { waiting.delete(requestId); clearTimeout(timer); resolve(false); }
  });
}

export function widgetVoiceLaunchConsumed(receipt: VoiceLaunchReceipt): void {
  if (!receipt || typeof receipt.requestId !== 'string') return;
  const request = waiting.get(receipt.requestId);
  if (!request || request.navigationId !== receipt.navigationId) return;
  waiting.delete(receipt.requestId);
  clearTimeout(request.timer);
  request.resolve(receipt.ok === true);
}
