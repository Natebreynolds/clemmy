/**
 * Compatibility surface for callers outside the Composio integration.
 * Provider-specific verification and provider capability names live at the
 * adapter edge; the shared harness contains no sender-provider branches.
 */
export * from '../../integrations/composio/outlook-sender-verifier.js';
