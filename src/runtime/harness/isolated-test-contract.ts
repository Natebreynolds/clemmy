/**
 * Isolated-test contract. Fixture APIs and the isolated transport may arm
 * only when this is active. Production registration never consults it to
 * weaken checks.
 */
export function isolatedTestContractActive(): boolean {
  return process.env.CLEMMY_TEST_ISOLATED_HOME === '1'
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.argv.includes('--test');
}
