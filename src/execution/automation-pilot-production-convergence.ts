/** Production saga composition for approved automation pilots.
 *
 * Approval listeners, daemon boot, daemon ticks, and trusted Workspace-choice
 * routes all call the same idempotent pass. Every authority remains in its own
 * control plane; this module only orders their reconcilers so no extra user
 * "continue" turn is required after a human decision.
 */
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import {
  blockAutomationPilotWorkspaceDestination,
  listAutomationPilotAdvancements,
  reconcileAutomationPilotAdvancements,
  type AutomationPilotAdvancementPortsV1,
} from './automation-pilot-advancement-control-plane.js';
import {
  reconcileAutomationPilotAuthoringDispatches,
  type AutomationPilotAuthoringPortV1,
} from './automation-pilot-authoring-dispatcher.js';
import {
  ensureAutomationPilotWorkspaceChooser,
  reconcileAutomationPilotWorkspaceChoosers,
} from './automation-pilot-workspace-destination-authority.js';
import { reconcileAutomationOpportunityReviewProjections } from './automation-opportunity-review-control-plane.js';
import { reconcileAutomationReadPilotProjections } from './automation-read-pilot-control-plane.js';
import { reconcileAutomationReadPilotWorkspaceCreations } from './automation-read-pilot-workspace-control-plane.js';
import type { SpaceRecord } from '../spaces/store.js';

export interface AutomationPilotProductionConvergenceResult {
  passes: number;
  chooserCreated: number;
  chooserBlocked: number;
  chooserRecovered: number;
  authoringSubmitted: number;
  authoringBlocked: number;
  advancementsQueued: number;
  failures: number;
}

export interface AutomationPilotProductionConvergenceOptions {
  limit?: number;
  advancementPorts?: AutomationPilotAdvancementPortsV1;
  authoringPort?: AutomationPilotAuthoringPortV1;
  listWorkspaces?: () => readonly SpaceRecord[];
}

async function convergencePass(
  options: AutomationPilotProductionConvergenceOptions,
): Promise<AutomationPilotProductionConvergenceResult> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('automation pilot convergence limit must be from 1 through 1000');
  }
  const result: AutomationPilotProductionConvergenceResult = {
    passes: 1,
    chooserCreated: 0,
    chooserBlocked: 0,
    chooserRecovered: 0,
    authoringSubmitted: 0,
    authoringBlocked: 0,
    advancementsQueued: 0,
    failures: 0,
  };
  try { reconcileAutomationOpportunityReviewProjections({ limit }); } catch { result.failures += 1; }
  try { reconcileAutomationReadPilotWorkspaceCreations({ limit }); } catch { result.failures += 1; }
  try { reconcileAutomationReadPilotProjections({ limit }); } catch { result.failures += 1; }

  try {
    const first = await reconcileAutomationPilotAdvancements({
      limit,
      ...(options.advancementPorts ? { ports: options.advancementPorts } : {}),
      ...(options.listWorkspaces ? { listWorkspaces: options.listWorkspaces } : {}),
    });
    result.failures += first.failed;
    result.advancementsQueued += first.queued;
  } catch {
    result.failures += 1;
  }

  for (const advancement of listAutomationPilotAdvancements({
    stage: 'workspace_destination_required',
    limit,
  })) {
    try {
      const ensured = ensureAutomationPilotWorkspaceChooser({ advancementId: advancement.advancementId });
      if (ensured.ok) {
        if (ensured.created) result.chooserCreated += 1;
        continue;
      }
      const blocked = blockAutomationPilotWorkspaceDestination({
        advancementId: advancement.advancementId,
        expectedStateRevision: advancement.stateRevision,
        expectedStateDigest: advancement.stateDigest,
        code: ensured.code,
        detail: ensured.reason,
      });
      if (blocked.ok) result.chooserBlocked += 1;
      else result.failures += 1;
    } catch {
      result.failures += 1;
    }
  }
  try {
    const recovered = reconcileAutomationPilotWorkspaceChoosers({ limit });
    result.chooserRecovered += recovered.resolved;
    result.chooserBlocked += recovered.blocked;
    result.failures += recovered.failed;
  } catch {
    result.failures += 1;
  }

  try {
    const second = await reconcileAutomationPilotAdvancements({
      limit,
      ...(options.advancementPorts ? { ports: options.advancementPorts } : {}),
      ...(options.listWorkspaces ? { listWorkspaces: options.listWorkspaces } : {}),
    });
    result.failures += second.failed;
    result.advancementsQueued += second.queued;
  } catch {
    result.failures += 1;
  }

  try {
    const authored = await reconcileAutomationPilotAuthoringDispatches({
      limit: Math.min(limit, 100),
      ...(options.authoringPort ? { port: options.authoringPort } : {}),
    });
    result.authoringSubmitted += authored.submitted;
    result.authoringBlocked += authored.blocked;
    result.failures += authored.failed;
  } catch {
    result.failures += 1;
  }

  try {
    const third = await reconcileAutomationPilotAdvancements({
      limit,
      ...(options.advancementPorts ? { ports: options.advancementPorts } : {}),
      ...(options.listWorkspaces ? { listWorkspaces: options.listWorkspaces } : {}),
    });
    result.failures += third.failed;
    result.advancementsQueued += third.queued;
  } catch {
    result.failures += 1;
  }
  try { reconcileAutomationReadPilotProjections({ limit }); } catch { result.failures += 1; }
  try {
    const final = await reconcileAutomationPilotAdvancements({
      limit,
      ...(options.advancementPorts ? { ports: options.advancementPorts } : {}),
      ...(options.listWorkspaces ? { listWorkspaces: options.listWorkspaces } : {}),
    });
    result.failures += final.failed;
    result.advancementsQueued += final.queued;
  } catch {
    result.failures += 1;
  }
  return result;
}

let installed = false;
let inFlight: Promise<AutomationPilotProductionConvergenceResult> | undefined;
let rerunRequested = false;

export function reconcileAutomationPilotProductionConvergence(
  options: AutomationPilotProductionConvergenceOptions = {},
): Promise<AutomationPilotProductionConvergenceResult> {
  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }
  inFlight = (async () => {
    let aggregate: AutomationPilotProductionConvergenceResult = {
      passes: 0,
      chooserCreated: 0,
      chooserBlocked: 0,
      chooserRecovered: 0,
      authoringSubmitted: 0,
      authoringBlocked: 0,
      advancementsQueued: 0,
      failures: 0,
    };
    do {
      rerunRequested = false;
      const pass = await convergencePass(options);
      aggregate = {
        passes: aggregate.passes + 1,
        chooserCreated: aggregate.chooserCreated + pass.chooserCreated,
        chooserBlocked: aggregate.chooserBlocked + pass.chooserBlocked,
        chooserRecovered: aggregate.chooserRecovered + pass.chooserRecovered,
        authoringSubmitted: aggregate.authoringSubmitted + pass.authoringSubmitted,
        authoringBlocked: aggregate.authoringBlocked + pass.authoringBlocked,
        advancementsQueued: aggregate.advancementsQueued + pass.advancementsQueued,
        failures: aggregate.failures + pass.failures,
      };
    } while (rerunRequested);
    return aggregate;
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

export function installAutomationPilotProductionConvergenceListener(
  options: AutomationPilotProductionConvergenceOptions = {},
): void {
  if (installed) return;
  installed = true;
  approvalRegistry.onApprovalResolved(() => {
    void reconcileAutomationPilotProductionConvergence(options).catch(() => {
      // The exact rows remain durable; daemon boot/tick retries the same pass.
    });
  });
}

export const automationPilotProductionConvergenceInternalsForTest = {
  reset(): void {
    inFlight = undefined;
    rerunRequested = false;
  },
};
