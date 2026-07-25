const DISABLE_LIVE_MODELS_ENV = 'CLEMMY_TEST_DISABLE_LIVE_MODELS';

/**
 * The isolated repository suite must never spend subscription quota, consume an
 * API key, or depend on a developer's logged-in model state. Transport tests
 * inject fakes below this boundary; only the real network/process edge calls it.
 */
export function assertLiveModelTransportAllowed(transport: string): void {
  if (process.env[DISABLE_LIVE_MODELS_ENV] !== '1') return;
  const err = new Error(
    `Live model transport "${transport}" is disabled inside the isolated test suite. `
      + 'Inject the transport seam in this test instead of using developer credentials.',
  );
  err.name = 'LiveModelTransportDisabledError';
  throw err;
}

export function liveModelTransportsDisabled(): boolean {
  return process.env[DISABLE_LIVE_MODELS_ENV] === '1';
}
