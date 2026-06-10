import { shouldRetryToolCall, formatRetryMessage } from './retry-handler.js';

// Test: rate limit (transient) should retry
{
  const decision = shouldRetryToolCall(
    new Error('Rate limit exceeded (429)'),
    1,
  );
  if (!decision.shouldRetry || !decision.isTransient) {
    throw new Error('Rate limit should be classified as transient and retryable');
  }
  if (decision.delayMs !== 1000) {
    throw new Error('First retry should delay 1000ms');
  }
}

// Test: 5xx (transient) should retry with increasing delays
{
  const d1 = shouldRetryToolCall(new Error('service unavailable (500)'), 1);
  const d2 = shouldRetryToolCall(new Error('service unavailable (500)'), 2);
  const d3 = shouldRetryToolCall(new Error('service unavailable (500)'), 3);

  if (!d1.shouldRetry || d1.delayMs !== 1000) {
    throw new Error('Attempt 1 should delay 1000ms');
  }
  if (!d2.shouldRetry || d2.delayMs !== 2000) {
    throw new Error('Attempt 2 should delay 2000ms');
  }
  if (!d3.shouldRetry || d3.delayMs !== 4000) {
    throw new Error('Attempt 3 should delay 4000ms');
  }
}

// Test: 401 unauthorized (terminal) should NOT retry
{
  const decision = shouldRetryToolCall(new Error('401 Unauthorized'));
  if (decision.shouldRetry) {
    throw new Error('401 should not be retried');
  }
  if (decision.isTransient) {
    throw new Error('401 should not be classified as transient');
  }
}

// Test: 403 forbidden (terminal) should NOT retry
{
  const decision = shouldRetryToolCall(new Error('403 Forbidden - permission denied'));
  if (decision.shouldRetry) {
    throw new Error('403 should not be retried');
  }
}

// Test: 404 not found (terminal) should NOT retry
{
  const decision = shouldRetryToolCall(new Error('404 Not Found - resource does not exist'));
  if (decision.shouldRetry) {
    throw new Error('404 should not be retried');
  }
}

// Test: circuit-breaker - same transient error twice should give up
{
  const errorMsg = 'Timeout after 30 seconds';
  const decision = shouldRetryToolCall(
    new Error(errorMsg),
    1,
    [errorMsg, errorMsg], // Two previous timeouts
  );
  if (decision.shouldRetry) {
    throw new Error('Circuit-breaker should stop retrying after same error repeats');
  }
  if (!decision.isTransient) {
    throw new Error('Should still recognize as transient for error message');
  }
}

// Test: timeout is transient
{
  const decision = shouldRetryToolCall(new Error('Socket timeout after 30 seconds'), 1);
  if (!decision.shouldRetry || !decision.isTransient) {
    throw new Error('Timeout should be transient and retryable');
  }
}

// Test: network error is transient
{
  const decision = shouldRetryToolCall(new Error('ECONNRESET - connection reset by peer'), 1);
  if (!decision.shouldRetry || !decision.isTransient) {
    throw new Error('Network error should be transient and retryable');
  }
}

// Test: format message includes tool name
{
  const msg = formatRetryMessage(
    {
      shouldRetry: true,
      isTransient: true,
      delayMs: 1000,
      reason: 'Rate limit',
      attempt: 1,
      maxAttempts: 3,
    },
    'composio_execute_tool',
  );
  if (!msg.includes('composio_execute_tool')) {
    throw new Error('Format message should include tool name');
  }
  if (!msg.includes('1/3')) {
    throw new Error('Format message should show attempt count');
  }
}
