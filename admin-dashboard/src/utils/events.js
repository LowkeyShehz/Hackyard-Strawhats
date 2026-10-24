/**
 * Tiny app-wide event helpers (no external state library needed).
 */

export const REVIEW_QUEUE_CHANGED = 'nm:review-queue-changed';

/** Tell listeners (e.g. the sidebar badge) that the review queue changed. */
export function notifyReviewQueueChanged() {
    window.dispatchEvent(new Event(REVIEW_QUEUE_CHANGED));
}

/**
 * Turn a thrown fetch error into a friendly message. `fetch` rejects with a
 * TypeError ("Failed to fetch") when the server is unreachable.
 */
export function networkErrorMessage(err, fallback = 'Could not reach the server. Check your connection.') {
    if (!err || err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err.message || '')) {
        return fallback;
    }
    return err.message || fallback;
}
