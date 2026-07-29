export const DEFAULT_TEST_TARGETS = Object.freeze([
  'src/**/*.test.ts',
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

export function isolatedTestArgs(forwarded) {
  return [
    '--test',
    ...forwarded,
    ...(hasExplicitTestTarget(forwarded) ? [] : DEFAULT_TEST_TARGETS),
  ];
}
