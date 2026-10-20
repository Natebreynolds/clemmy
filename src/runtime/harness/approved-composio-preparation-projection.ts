/** Closed existing SDK-parser projection of a frozen approved carrier. Pure:
 * no stores, runtime contexts, client state or execution authority. */
import { carrierJsonObject } from './carrier-json.js';
import { normalizeComposioArgsPayload } from '../../tools/composio-carrier.js';
export function approvedComposioPreparationProjection(payload:unknown): {
  toolSlug:string; connectedAccountId:string; args:Record<string,unknown>;
} | null {
  if (!payload || typeof payload!=='object' || Array.isArray(payload)) return null;
  const outer=payload as Record<string,unknown>;
  const account=outer.connected_account_id;
  const raw=outer.arguments===null ? {} : carrierJsonObject(outer.arguments);
  const normalized=normalizeComposioArgsPayload(outer.arguments);
  if (typeof outer.tool_slug!=='string' || typeof account!=='string' || account!==account.trim() || !account
    || /^(null|undefined|none)$/i.test(account) || !raw || !normalized.ok
    || ['connected_account_id','connectedAccountId','connection_id','connectionId'].some(key=>
      Object.prototype.hasOwnProperty.call(raw,key) && raw[key]!==account)
    || Object.prototype.hasOwnProperty.call(raw,'account_alias')) return null;
  return {toolSlug:outer.tool_slug,connectedAccountId:account,args:normalized.args};
}
