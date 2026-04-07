/**
 * Trigger — Workflow Schema Utilities
 * Validation, failure classification, and step type helpers.
 */

export const STEP_TYPES = ['click', 'input', 'select', 'check', 'keypress', 'navigate'];

export function validateReplayWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') {
    return { valid: false, error: 'workflow must be an object' };
  }
  if (!workflow.id || typeof workflow.id !== 'string') {
    return { valid: false, error: 'workflow.id is required' };
  }
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    return { valid: false, error: 'workflow.steps must be a non-empty array' };
  }
  if (!workflow.startUrl || typeof workflow.startUrl !== 'string') {
    return { valid: false, error: 'workflow.startUrl is required' };
  }
  return { valid: true };
}

export function buildReplayFreshnessSample(steps) {
  var sample = [];
  for (var i = 0; i < steps.length && sample.length < 3; i += 1) {
    var step = steps[i];
    if (!step || !step.target) continue;
    sample.push({ ...step, index: typeof step.index === 'number' ? step.index : i });
  }
  return sample;
}

export function classifyFailure(reason, reasonType) {
  if (reasonType) return reasonType;
  var text = String(reason || '').toLowerCase();
  if (text.includes('auth wall') || text.includes('sign in required') || text.includes('signin') || text.includes('login') || text.includes('sso')) return 'auth_wall';
  if (text.includes('not found') || text.includes('low confidence')) return 'selector_not_found';
  if (text.includes('timeout') || text.includes('timed out')) return 'navigation_timeout';
  if (text.includes('captcha') || text.includes('recaptcha') || text.includes('hcaptcha') || text.includes('turnstile')) return 'captcha_challenge';
  if (text.includes('permission') || text.includes('denied')) return 'permission_error';
  if (text.includes('aborted')) return 'aborted';
  if (text.includes('unknown step')) return 'action_error';
  return 'unknown_error';
}

export function isRetryableFailure(reasonType) {
  return reasonType === 'selector_not_found' || reasonType === 'navigation_timeout' || reasonType === 'unknown_error';
}
