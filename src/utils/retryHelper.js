/**
 * Nirman Mitra — Retry with Exponential Backoff
 * Generic retry wrapper for any AWS service call.
 * Works for any AWS SDK or HTTP call.
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 5000;

/**
 * Retry a function with exponential backoff.
 * Retries only on throttling or transient errors.
 * @param {Function} fn - Async function to retry
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.baseDelayMs=1000]
 * @param {number} [options.maxDelayMs=5000] - Upper bound for a single backoff wait
 * @param {string} [options.label=''] - Label for logging
 * @returns {Promise<*>} Result of fn()
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    label = '',
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !isRetryable(err)) {
        throw err;
      }

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      console.warn(
        `[Retry${label ? ` ${label}` : ''}] Attempt ${attempt + 1}/${maxRetries} failed: ${err.message}. Retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Exponential backoff capped at maxDelayMs, with "equal jitter": a random wait between
 * half and all of the capped delay, so concurrent callers do not retry in lockstep.
 */
export function backoffDelay(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS) {
  const capped = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/**
 * Check if an error is retryable (throttling or transient service error).
 */
function isRetryable(err) {
  // Throttling errors
  if (
    err.name === 'ThrottlingException' ||
    err.name === 'TooManyRequestsException' ||
    err.name === 'ProvisionedThroughputExceededException' ||
    err.name === 'RequestLimitExceeded' ||
    err.name === 'LimitExceededException' ||
    err.$metadata?.httpStatusCode === 429
  ) {
    return true;
  }

  // Transient service errors (5xx)
  const statusCode = err.$metadata?.httpStatusCode;
  if (statusCode && statusCode >= 500 && statusCode < 600) {
    return true;
  }

  // Network/timeout errors
  if (
    err.code === 'ECONNRESET' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'EPIPE' ||
    err.name === 'TimeoutError' ||
    err.name === 'ServiceUnavailableException' ||
    err.name === 'InternalServerError'
  ) {
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default { withRetry, backoffDelay };
