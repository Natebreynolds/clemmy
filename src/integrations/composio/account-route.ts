/**
 * Exact harness-owned note appended to successful reads that use the
 * authenticated Composio CLI's provider-side default account.
 *
 * Keep this formatter shared by the dispatch path and any verifier that is
 * allowed to project the note away. A verifier must still bind `toolkit` to
 * the effective action before treating the rendered bytes as harness-owned.
 */
export function formatComposioCliDefaultReadAccountRoute(toolkit: string): string {
  return `[account-route] Read through the authenticated Composio CLI's provider-side ${toolkit} default; no connected_account_id was selected or claimed.`;
}
