/**
 * Trigger — Runtime Configuration
 * Environment-aware getters for backend URL and other config.
 */

export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    var parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (err) {
    return null;
  }
}

/**
 * Get the backend base URL based on the execution context.
 * @param {'extension'|'viewer'|'backend'|'worker'} context
 * @returns {Promise<string|null>}
 */
export async function getBackendUrl(context) {
  if (context === 'extension') {
    var _browser = typeof browser !== 'undefined' ? browser : chrome;
    var result = await _browser.storage.sync.get('backendUrl');
    return sanitizeUrl(result.backendUrl) || null;
  }

  if (context === 'viewer') {
    // When hosted, default to same-origin
    if (typeof window !== 'undefined' && window.location) {
      return window.location.origin;
    }
    return null;
  }

  // Node.js contexts: backend, worker
  if (typeof process !== 'undefined' && process.env) {
    return sanitizeUrl(process.env.BACKEND_URL) || null;
  }

  return null;
}
