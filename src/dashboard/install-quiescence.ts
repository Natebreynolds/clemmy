/** Runtime adapter for the canonical observational installation inventory. */
import { BASE_DIR } from '../config.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { getUserInputEventAtSequence, openEventLog } from '../runtime/harness/eventlog.js';
import { getBackgroundTask } from '../execution/background-tasks.js';
import { readWorkflowRunInventoryFile } from '../execution/workflow-run-inventory.js';
import { auditAcceptedSourceSettlementTruth } from '../runtime/harness/accepted-source-settlement-audit.js';
import { readRecoveryActivation } from '../runtime/harness/recovery-activation.js';
import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';
import { get as getApproval } from '../runtime/harness/approval-registry.js';
import { isTerminalWorkflowRunStatus } from '../execution/workflow-run-cancellation.js';
import { readInstallQuiescenceRead, type InstallQuiescenceReader } from './install-quiescence-read.js';
export { unverifiedInstallQuiescence } from './install-quiescence-read.js';
export type { InstallWorkOwner, InstallQuiescenceSnapshot } from './install-quiescence-read.js';

const runtimeReader: InstallQuiescenceReader = {
  BASE_DIR, WORKFLOW_RUNS_DIR, database: openEventLog,
  getUserInputEventAtSequence, getBackgroundTask, readWorkflowRunInventoryFile,
  auditAcceptedSourceSettlementTruth, readRecoveryActivation,
  presentationEventFromCompletionData, getApproval, isTerminalWorkflowRunStatus,
};

export function readInstallQuiescence(options: { nowMs?: number; maxEntries?: number } = {}) {
  return readInstallQuiescenceRead(options, runtimeReader);
}
