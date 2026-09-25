/**
 * The honest receipt for one turn of a delegated coding agent, and Clem's
 * review of it.
 *
 * What the agent says it did is one input among several, never the verdict.
 * The receipt is built from git (the run branch's commits past its base, the
 * diff, anything left uncommitted), the test command Clem runs herself in the
 * worktree, and the agent's final message. Tests failing or nothing changing
 * are facts that send the agent back to work; otherwise the completion judge
 * reads the whole receipt against the objective. A judge that cannot answer
 * leaves the work unverified — it is never counted as a pass.
 */
import { judgeObjectiveCompleteStrict } from '../runtime/harness/objective-judge.js';
import { commitLeftovers, readGitEvidence, runTestCommand, type GitEvidence, type TestRunResult } from './coding-run-git.js';
import type { CodingRunRecord, CodingRunVerdict } from './coding-run-store.js';

export interface CodingRunReceipt {
  evidence: GitEvidence;
  autoCommitted: boolean;
  test: TestRunResult | null;
  finalMessage: string;
  agentTurnOk: boolean;
}

export interface CodingRunReview {
  /** `done` settles; `continue` sends the agent the follow-up below. */
  next: 'done' | 'continue';
  verdict: CodingRunVerdict;
  reason: string;
  followUp: string | null;
}

export async function buildCodingRunReceipt(
  run: Pick<CodingRunRecord, 'worktreePath' | 'baseCommit' | 'testCommand' | 'agent'>,
  turn: { finalMessage: string; ok: boolean },
): Promise<CodingRunReceipt> {
  const autoCommitted = await commitLeftovers(run.worktreePath, `Save uncommitted work from the ${run.agent} coding run`);
  const evidence = await readGitEvidence(run.worktreePath, run.baseCommit);
  const test = run.testCommand ? await runTestCommand(run.testCommand, run.worktreePath) : null;
  return { evidence, autoCommitted, test, finalMessage: turn.finalMessage, agentTurnOk: turn.ok };
}

export function hasChanges(receipt: CodingRunReceipt): boolean {
  return receipt.evidence.commits.length > 0 || receipt.evidence.dirtyFiles.length > 0;
}

export function testsFailed(receipt: CodingRunReceipt): boolean {
  return Boolean(receipt.test) && (receipt.test!.timedOut || receipt.test!.exitCode !== 0);
}

/** The receipt as the judge and the report-back read it. */
export function renderCodingRunReceipt(run: Pick<CodingRunRecord, 'branch' | 'testCommand'>, receipt: CodingRunReceipt): string {
  const lines: string[] = [];
  lines.push(`Agent's final message:\n${receipt.finalMessage.trim() || '(none)'}`);
  const { commits, diffStat, dirtyFiles } = receipt.evidence;
  lines.push(commits.length
    ? `Commits on ${run.branch}:\n${commits.map((c) => `- ${c.sha.slice(0, 10)} ${c.subject}`).join('\n')}`
    : `No commits on ${run.branch}.`);
  if (diffStat.filesChanged > 0) {
    lines.push(`Diff: ${diffStat.filesChanged} file(s), +${diffStat.insertions} -${diffStat.deletions}\n`
      + diffStat.files.slice(0, 40).map((f) => `- ${f}`).join('\n'));
  }
  if (receipt.autoCommitted) lines.push('Clem committed changes the agent had left uncommitted.');
  if (dirtyFiles.length) lines.push(`Still uncommitted (a commit hook refused them):\n${dirtyFiles.slice(0, 40).map((f) => `- ${f}`).join('\n')}`);
  if (receipt.test) {
    const status = receipt.test.timedOut ? 'timed out' : `exited ${receipt.test.exitCode}`;
    lines.push(`Tests (\`${run.testCommand}\`, run by Clem in the worktree) ${status}.\nOutput tail:\n${receipt.test.tail.slice(-3_000)}`);
  } else {
    lines.push('No test command was set for this run.');
  }
  return lines.join('\n\n');
}

type Judge = (objective: string, receiptText: string) => Promise<{ done: boolean; reason: string }>;
let judgeImpl: Judge = (objective, text) => judgeObjectiveCompleteStrict(objective, text);
/** Test seam — the completion judge is a live model call. */
export function setCodingRunJudgeForTests(fn: Judge | null): void {
  judgeImpl = fn ?? ((objective, text) => judgeObjectiveCompleteStrict(objective, text));
}

function judgedObjective(run: Pick<CodingRunRecord, 'objective' | 'acceptance'>): string {
  return run.acceptance.length
    ? `${run.objective}\n\nAcceptance criteria:\n${run.acceptance.map((c) => `- ${c}`).join('\n')}`
    : run.objective;
}

/**
 * Decide whether the agent is done. Objective facts first — failing tests and
 * an empty diff on work that should change code are not matters of opinion —
 * then the judge. Out of rounds, the last verdict stands and the run settles.
 */
export async function reviewCodingRunReceipt(
  run: Pick<CodingRunRecord, 'objective' | 'acceptance' | 'branch' | 'testCommand' | 'expectChanges' | 'round' | 'maxRounds'>,
  receipt: CodingRunReceipt,
): Promise<CodingRunReview> {
  const roundsLeft = run.round + 1 < run.maxRounds;
  const sendBack = (verdict: CodingRunVerdict, reason: string, followUp: string): CodingRunReview => (
    roundsLeft ? { next: 'continue', verdict, reason, followUp } : { next: 'done', verdict, reason, followUp: null }
  );

  if (testsFailed(receipt)) {
    const test = receipt.test!;
    const status = test.timedOut ? 'timed out' : `exited ${test.exitCode}`;
    return sendBack(
      'fail',
      `The tests (${run.testCommand}) ${status}.`,
      `Clem here. I ran \`${run.testCommand}\` in your worktree and it ${status}. Here is the end of the output:\n\n`
        + `${test.tail.slice(-2_500)}\n\nFix the cause, commit on this branch, and tell me when the tests pass.`,
    );
  }
  if (run.expectChanges && !hasChanges(receipt)) {
    return sendBack(
      'fail',
      'The agent finished without changing anything on the run branch.',
      'Clem here. I see no commits and no changed files on this branch yet. The task needs code changes: '
        + 'make them, commit them on this branch, and tell me what you changed.',
    );
  }

  let verdict: { done: boolean; reason: string };
  try {
    verdict = await judgeImpl(judgedObjective(run), renderCodingRunReceipt(run, receipt));
  } catch (error) {
    return {
      next: 'done',
      verdict: 'unavailable',
      reason: `The completion check could not run (${error instanceof Error ? error.message : String(error)}); the work is unverified.`,
      followUp: null,
    };
  }
  if (verdict.done) return { next: 'done', verdict: 'pass', reason: verdict.reason, followUp: null };
  return sendBack(
    'fail',
    verdict.reason,
    `Clem here. I reviewed your work against the task and it is not finished yet: ${verdict.reason}\n\n`
      + 'Keep going on this branch, commit what you change, and tell me when it is done.',
  );
}
