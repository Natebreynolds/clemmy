import type { SpaceRecord } from './store.js';

/**
 * Workspace WIRING health — a surface must know when its own plumbing can't
 * deliver what its UI promises, and say so where the user is looking.
 *
 * Live incident (2026-08-06): a workspace's "Refresh from Salesforce" button
 * ran its runner for real (approval → execution → exit 0 → "ran ✓") and the
 * result went nowhere — the space had `dataSources: []`, so nothing persisted
 * and the view stayed a static Jul-30 snapshot. Execution receipts read as
 * proof of EFFECT. The owner's global framing: don't bury this in run notes or
 * authoring-time validation — the workspace itself shows "data sources aren't
 * attached", and the remedy is one ask to Clem, who repairs it in conversation.
 *
 * Pure + advisory by design (guardrails inform, they never block): findings
 * describe wiring, name the remedy, and are rendered as a banner injected at
 * view-serve time — so every EXISTING workspace self-diagnoses with zero
 * re-authoring. Deliberately ONE finding class for now; add classes only with
 * live evidence.
 */

export interface SpaceWiringFinding {
  kind: 'refresh_without_data_source';
  /** One plain sentence: what is wrong, in user terms. */
  summary: string;
  /** The copy-ready ask that routes repair through Clem. */
  askClem: string;
  /** Action ids implicated, for chrome that wants to badge them. */
  actionIds: string[];
}

export function spaceWiringHealth(rec: Pick<SpaceRecord, 'title' | 'dataSources' | 'actions'>): SpaceWiringFinding[] {
  const findings: SpaceWiringFinding[] = [];
  const runnerActions = (rec.actions ?? []).filter((a) => typeof a.runner === 'string' && a.runner.trim().length > 0);
  if ((rec.dataSources ?? []).length === 0 && runnerActions.length > 0) {
    const labels = runnerActions.map((a) => a.label || a.id).join(', ');
    findings.push({
      kind: 'refresh_without_data_source',
      summary: `This view is a static snapshot — no live data source is attached, so “${labels}” runs but the view never updates.`,
      askClem: `Fix the “${rec.title}” workspace: attach its refresh runner as a live data source so the view updates from real data instead of a baked-in snapshot.`,
      actionIds: runnerActions.map((a) => a.id),
    });
  }
  return findings;
}

/** Minimal, theme-safe advisory banner for view-serve injection. Inert markup
 * only (no authored-script interference, no external requests); dismiss hides
 * it for the tab session — advisories inform, they never nag or block.
 * Fixed-positioned because it is appended at END of body (the head seam is
 * reserved for the bridge, which must run before authored scripts — a banner
 * has no such ordering need and must never risk that invariant). */
export function wiringHealthBannerSnippet(findings: SpaceWiringFinding[]): string {
  if (findings.length === 0) return '';
  const f = findings[0];
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return [
    '<div id="clem-wiring-health" style="position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#7a5b00;color:#fff;',
    'font:13px/1.45 -apple-system,system-ui,sans-serif;padding:8px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.25)">',
    `<span style="flex:1">⚠ ${esc(f.summary)} <b>Ask Clem:</b> “${esc(f.askClem)}”</span>`,
    '<button onclick="document.getElementById(\'clem-wiring-health\').remove()" ',
    'style="background:transparent;border:1px solid rgba(255,255,255,.6);color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer">Dismiss</button>',
    '</div>',
  ].join('');
}

/** Insert the banner before </body> when one exists, else append. End-of-body
 * on purpose: authored scripts and the head bridge keep their exact order. */
export function appendWiringHealthBanner(html: string, findings: SpaceWiringFinding[]): string {
  const snippet = wiringHealthBannerSnippet(findings);
  if (!snippet) return html;
  const close = html.toLowerCase().lastIndexOf('</body>');
  return close >= 0
    ? `${html.slice(0, close)}${snippet}${html.slice(close)}`
    : `${html}${snippet}`;
}
