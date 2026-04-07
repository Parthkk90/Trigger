/**
 * Trigger — Element Fingerprinting (Content Script Bridge)
 * Imports shared fingerprint engine and exposes on window.Trigger.
 */

import {
  CONFIDENCE_AUTO,
  CONFIDENCE_SHOW,
  generateFingerprint,
  resolveFingerprint,
  scoreCandidateMatch,
} from '../../shared/fingerprint.js';

window.Trigger = window.Trigger || {};

window.Trigger.CONFIDENCE_AUTO = CONFIDENCE_AUTO;
window.Trigger.CONFIDENCE_SHOW = CONFIDENCE_SHOW;
window.Trigger.generateFingerprint = generateFingerprint;
window.Trigger.resolveFingerprint = function (fingerprint) {
  return resolveFingerprint(fingerprint, document);
};
window.Trigger.scoreCandidateMatch = scoreCandidateMatch;
