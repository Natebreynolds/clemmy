/**
 * Clem's report, in the chat that started it, of how a workflow run ended.
 *
 * A run started from a chat reports back into that chat, and its report was
 * the runner's own template ("⚠️ … couldn't finish — 1 step blocked: • step:
 * …"): the global voice pass skips a run with an origin observer, so the owner
 * read harness text where Clem should have spoken (live 2026-10-18). Here the
 * configured brain, which the owner chose, writes that report from the run's
 * facts and what the owner asked for, as it already does for an approved
 * action that did not go through.
 *
 * Fail-safe in both directions: no brain in time, an empty reply, a blocked or
 * failed run told as a success, or a link or file path the report never named
 * keeps the runner's report as written. A retained-work inventory is the
 * origin's to re-project, so it rides after Clem's words byte for byte.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import pino from 'pino';
import { getUserInputEventAtSequence } from '../runtime/harness/eventlog.js';
import { publicUserInputText } from '../runtime/harness/public-presentation.js';
import { RETAINED_WORK_TERMINAL_HEADER } from '../runtime/harness/retained-work-checkpoint.js';
import { CLEM_VOICE_PURPOSE } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import { withOwnModelRequestAttribution } from '../runtime/usage-log.js';
import { readWorkflowRunOriginRecords } from '../tools/workflow-run-queue.js';
import { applyVoiceGuards } from './voice-rewrite.js';

const logger = pino({ name: 'clementine-next.workflow-ending-voice' });

export const WORKFLOW_ENDING_VOICE_DEADLINE_MS = 20_000;
/** Longer reports are delivered as written; the brain call is not worth it. */
const MAX_REPORT_CHARS = 8_000;

export type WorkflowEndingOutcome = 'done' | 'blocked' | 'failed';

/** The links and file paths a text names, home-relative paths expanded. */
function locations(text: string): string[] {
  const home = os.homedir();
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s)<>"'`]+|(?:~|\/(?:Users|home|tmp|private|var|Volumes))\/[^\s)<>"'`,;]+/g)) {
    const raw = match[0].replace(/[.:!?]+$/u, '');
    found.add(raw.startsWith('~/') ? `${home}${raw.slice(1)}` : raw);
  }
  return [...found];
}

/** Clem's message keeps the run's verdict and names no link or file path the
 * report does not. */
export function workflowEndingKeepsFacts(message: string, report: string, outcome: WorkflowEndingOutcome): boolean {
  const said = message.trim();
  if (!said) return false;
  if (applyVoiceGuards({ message: said, nothingHappened: false }, report, outcome).message !== said) return false;
  const known = new Set(locations(report));
  return locations(said).every((location) => known.has(location));
}

/** Split a report into the part Clem tells and the retained-work inventory
 * that must reach the origin unchanged. */
function splitRetained(report: string): { told: string; retained: string } {
  const at = report.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  return at < 0 ? { told: report, retained: '' } : { told: report.slice(0, at).trimEnd(), retained: report.slice(at) };
}

/**
 * The report in Clem's words for the chat that started `runId`, or null to keep
 * the runner's report. Only a run with an exact chat origin is voiced here.
 */
export async function workflowEndingInClemsWords(input: {
  runId: string;
  workflow: string;
  outcome: WorkflowEndingOutcome;
  report: string;
}): Promise<string | null> {
  const port = peekTurnSemanticModelPort();
  if (!port?.voiceWorkflowRunEnding) return null;
  const { told, retained } = splitRetained(input.report);
  if (!told.trim() || told.length > MAX_REPORT_CHARS) return null;
  try {
    const origin = readWorkflowRunOriginRecords(input.runId).find((record) => record.version === 2);
    if (!origin) return null;
    const accepted = getUserInputEventAtSequence(origin.originSessionId, origin.sourceUserSeq);
    const asked = accepted && accepted.data.synthetic !== true ? publicUserInputText(accepted.data) : '';
    const work = withOwnModelRequestAttribution(
      { sessionId: origin.originSessionId, sourceUserSeq: origin.sourceUserSeq },
      () => port.voiceWorkflowRunEnding!({
        purpose: CLEM_VOICE_PURPOSE,
        asked: asked.slice(0, 2_000),
        workflow: input.workflow,
        outcome: input.outcome,
        report: told,
        evidenceDigest: createHash('sha256').update(`${input.runId}\0${told}`).digest('hex'),
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WORKFLOW_ENDING_VOICE_DEADLINE_MS); });
    const result = await Promise.race([work, deadline]).finally(() => { if (timer) clearTimeout(timer); });
    const message = result?.message?.trim() ?? '';
    if (!message || !workflowEndingKeepsFacts(message, told, input.outcome)) {
      if (message) logger.warn({ runId: input.runId }, 'workflow ending: Clem\'s words changed a fact; the report stands');
      return null;
    }
    return retained ? `${message}\n\n${retained}` : message;
  } catch (err) {
    logger.warn({ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
      'workflow ending: Clem could not be reached; the report stands');
    return null;
  }
}
