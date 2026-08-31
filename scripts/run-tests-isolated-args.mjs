export const DEFAULT_TEST_TARGETS = Object.freeze([
  // Performance-sensitive end-to-end journeys have their own serialized
  // `npm run journeys` gate. Running them again in the broad concurrent unit
  // suite makes their latency contract measure sibling-test contention rather
  // than Clementine. Keep this list explicit so adding a new source area also
  // requires deciding which gate owns it.
  'src/*.test.ts',
  'src/agents/**/*.test.ts',
  'src/assistant/**/*.test.ts',
  'src/autoresearch/**/*.test.ts',
  'src/channels/**/*.test.ts',
  'src/cli/**/*.test.ts',
  'src/daemon/**/*.test.ts',
  'src/dashboard/**/*.test.ts',
  'src/execution/**/*.test.ts',
  'src/gateway/**/*.test.ts',
  'src/integrations/**/*.test.ts',
  'src/memory/**/*.test.ts',
  'src/planning/**/*.test.ts',
  'src/plugins/**/*.test.ts',
  'src/runtime/**/*.test.ts',
  'src/setup/**/*.test.ts',
  'src/shared/**/*.test.ts',
  'src/spaces/**/*.test.ts',
  'src/tasks/**/*.test.ts',
  'src/tools/**/*.test.ts',
  'apps/**/*.test.ts',
]);

const TEST_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
]);

function hasExplicitTestTarget(forwarded) {
  let consumeAsOptionValue = false;

  for (let index = 0; index < forwarded.length; index += 1) {
    const argument = forwarded[index];
    if (consumeAsOptionValue) {
      consumeAsOptionValue = false;
      continue;
    }
    if (argument === '--') return index + 1 < forwarded.length;
    if (!argument.startsWith('-')) return true;

    const optionName = argument.split('=', 1)[0];
    if (!argument.includes('=') && TEST_OPTIONS_WITH_SEPARATE_VALUE.has(optionName)) {
      consumeAsOptionValue = true;
    }
  }

  return false;
}

export const TEST_ISOLATION_PRELOAD = new URL('./test-isolation-preload.mjs', import.meta.url).href;

const TEST_FILE_SUFFIX = String.raw`\.test\.[cm]?[jt]sx?`;

function reportedTestFile(line) {
  // These are reporter-owned file boundaries. Do not accept a bare path found
  // anywhere in a line: a hung test can keep printing logs, and ordinary log
  // chatter must never feed the watchdog that is supposed to stop it.
  const tapBoundary = line.match(new RegExp(`^# Subtest:\\s+(\\S+${TEST_FILE_SUFFIX})\\s*$`));
  if (tapBoundary) return tapBoundary[1];

  const specBoundary = line.match(new RegExp(`^[\u25b6\u2714\u2718]\\s+(\\S+${TEST_FILE_SUFFIX})(?:\\s+\\([^)]*\\))?\\s*$`));
  return specBoundary?.[1] ?? null;
}

/**
 * Tracks only test-runner-owned progress records.
 *
 * Node's default TAP reporter does not print a file path when a file contains
 * named tests. In a serialized suite that left the outer watchdog anchored at
 * process launch even as hundreds of real tests completed. Ordered, top-level
 * TAP result records are the only portable boundary available in that output.
 * Requiring the TAP header and the next exact ordinal keeps arbitrary stdout
 * (including lines that merely mention `ok` or a test path) from extending a
 * genuinely hung test indefinitely.
 */
export function createIsolatedRunnerProgressTracker(startedAt = Date.now()) {
  let currentFile = '(not reported by test reporter)';
  let lastProgress = 'process launch';
  let lastProgressAt = startedAt;
  let nextTapOrdinal = null;

  return {
    observe(line, at = Date.now(), { allowTap = true } = {}) {
      const owningFile = reportedTestFile(line);
      if (owningFile) {
        currentFile = owningFile;
        lastProgress = `file boundary ${owningFile}`;
        lastProgressAt = at;
        return true;
      }

      if (!allowTap) return false;
      if (/^TAP version \d+\s*$/.test(line)) {
        // A nested test's captured TAP is prefixed with "# " and cannot reach
        // this branch. Never restart an already-active sequence from chatter.
        if (nextTapOrdinal === null) nextTapOrdinal = 1;
        return false;
      }

      const result = line.match(/^(?:ok|not ok) ([1-9]\d*) - .*$/);
      if (!result || nextTapOrdinal === null) return false;
      const ordinal = Number(result[1]);
      if (ordinal !== nextTapOrdinal) return false;

      nextTapOrdinal += 1;
      lastProgress = `TAP test ${ordinal} completed`;
      lastProgressAt = at;
      return true;
    },

    snapshot() {
      return { currentFile, lastProgress, lastProgressAt };
    },
  };
}

export function isolatedTestArgs(forwarded) {
  const hasTimeout = forwarded.some((argument) => argument === '--test-timeout' || argument.startsWith('--test-timeout='));
  return [
    '--import',
    TEST_ISOLATION_PRELOAD,
    '--test',
    ...(hasTimeout ? [] : ['--test-timeout', '600000']),
    ...forwarded,
    ...(hasExplicitTestTarget(forwarded) ? [] : DEFAULT_TEST_TARGETS),
  ];
}
