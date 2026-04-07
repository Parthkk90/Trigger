/**
 * Trigger — Shared Constants
 * Single source of truth for thresholds, timing values, and limits.
 */

// Confidence thresholds
export const CONFIDENCE_AUTO = 85;
export const CONFIDENCE_SHOW = 50;

// Replay timing
export const STEP_DELAY_MS = 300;
export const ELEMENT_WAIT_MS = 5000;
export const ELEMENT_POLL_MS = 200;
export const NAV_AUTH_SETTLE_MS = 500;

// Keepalive & recovery
export const KEEPALIVE_INTERVAL_MS = 20000;
export const REPLAY_HEARTBEAT_STALE_MS = 45000;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const MAX_STEP_RETRIES = 3;
export const REPLAY_FRESHNESS_THRESHOLD = 60;

// Upload retry
export const UPLOAD_MAX_RETRIES = 5;
export const UPLOAD_INITIAL_BACKOFF_MS = 2000;
export const UPLOAD_QUEUE_KEY = 'uploadRetryQueue';

// Screenshot
export const SCREENSHOT_CAPTURE_TIMEOUT_MS = 1500;
