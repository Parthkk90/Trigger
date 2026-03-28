/**
 * Trigger — Recorder
 * Captures user interactions (click, type, navigate) as structured step objects.
 * Runs inside the content script during recording.
 */

(function () {
  'use strict';

  window.Trigger = window.Trigger || {};

  var isRecording = false;
  var lastInputElement = null;
  var inputBuffer = '';
  var inputDebounceTimer = null;

  // ── Public API ─────────────────────────────────────────────────

  window.Trigger.startRecording = function () {
    if (isRecording) return;
    isRecording = true;

    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('input', onInputCapture, true);
    document.addEventListener('change', onChangeCapture, true);
    document.addEventListener('keydown', onKeydownCapture, true);

    recordStep({
      type: 'navigate',
      url: window.location.href,
      title: document.title,
    });
  };

  window.Trigger.stopRecording = function () {
    if (!isRecording) return;
    isRecording = false;

    flushInputBuffer();

    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('input', onInputCapture, true);
    document.removeEventListener('change', onChangeCapture, true);
    document.removeEventListener('keydown', onKeydownCapture, true);
  };

  // ── Event Handlers ─────────────────────────────────────────────

  function onClickCapture(event) {
    var target = event.target;
    if (!target || target === document.body || target === document.documentElement) return;
    if (target.closest('#trigger-overlay')) return;

    if (lastInputElement && lastInputElement !== target) {
      flushInputBuffer();
    }

    var fingerprint = window.Trigger.generateFingerprint(target);

    var anchor = target.closest('a');
    var willNavigate = anchor && anchor.href && anchor.href.indexOf('javascript:') !== 0;

    var step = { type: 'click', target: fingerprint };
    if (willNavigate) step.navigatesTo = anchor.href;

    recordStep(step);
  }

  function onInputCapture(event) {
    var target = event.target;
    if (!target || target.closest('#trigger-overlay')) return;

    if (lastInputElement !== target) {
      flushInputBuffer();
      lastInputElement = target;
    }

    inputBuffer = target.value;

    clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(function () {
      flushInputBuffer();
    }, 500);
  }

  function onChangeCapture(event) {
    var target = event.target;
    if (!target || target.closest('#trigger-overlay')) return;

    var tag = target.tagName.toLowerCase();

    if (tag === 'select') {
      recordStep({
        type: 'select',
        target: window.Trigger.generateFingerprint(target),
        value: target.value,
        selectedText: target.options[target.selectedIndex] ? target.options[target.selectedIndex].text : '',
      });
    } else if (target.type === 'checkbox' || target.type === 'radio') {
      recordStep({
        type: 'check',
        target: window.Trigger.generateFingerprint(target),
        checked: target.checked,
      });
    }
  }

  function onKeydownCapture(event) {
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
      var target = event.target;
      if (target && target !== document.body) {
        if (isSensitiveInputTarget(target)) {
          if (event.key === 'Enter' || event.key === 'Tab') flushInputBuffer();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') flushInputBuffer();
        recordStep({
          type: 'keypress',
          target: window.Trigger.generateFingerprint(target),
          key: event.key,
        });
      }
    }
  }

  // ── Input Buffering ────────────────────────────────────────────

  function flushInputBuffer() {
    if (!lastInputElement || !inputBuffer) {
      lastInputElement = null;
      inputBuffer = '';
      return;
    }

    var isSensitive = isSensitiveInputTarget(lastInputElement) || looksSensitiveValue(inputBuffer);

    recordStep({
      type: 'input',
      target: window.Trigger.generateFingerprint(lastInputElement),
      value: isSensitive ? '' : inputBuffer,
      sensitive: !!isSensitive,
    });

    lastInputElement = null;
    inputBuffer = '';
    clearTimeout(inputDebounceTimer);
  }

  function isSensitiveInputTarget(target) {
    if (!target) return false;

    var type = (target.type || '').toLowerCase();
    var name = (target.name || '').toLowerCase();
    var id = (target.id || '').toLowerCase();
    var placeholder = (target.placeholder || '').toLowerCase();
    var aria = (target.getAttribute('aria-label') || '').toLowerCase();
    var autocomplete = (target.autocomplete || '').toLowerCase();

    if (type === 'password') return true;

    if (
      autocomplete === 'cc-number' ||
      autocomplete === 'cc-csc' ||
      autocomplete === 'cc-exp' ||
      autocomplete === 'cc-exp-month' ||
      autocomplete === 'cc-exp-year' ||
      autocomplete === 'one-time-code'
    ) {
      return true;
    }

    var combined = name + ' ' + id + ' ' + placeholder + ' ' + aria;
    return /(password|passcode|passwd|secret|token|otp|ssn|social|credit|card|cvv|cvc|pin)/.test(combined);
  }

  function looksSensitiveValue(value) {
    if (!value || typeof value !== 'string') return false;

    var compact = value.replace(/[\s-]/g, '');
    if (/^\d{13,19}$/.test(compact)) return true;
    if (/^\d{3}-?\d{2}-?\d{4}$/.test(value)) return true;
    return false;
  }

  // ── Step Dispatch ──────────────────────────────────────────────

  function recordStep(step) {
    console.log('[Trigger] Recording step:', step);
    chrome.runtime.sendMessage({ type: 'RECORD_STEP', step: step }).catch(function (err) {
      console.error('[Trigger] Failed to send RECORD_STEP:', err);
    });
  }

  // ── SPA Navigation Detection ───────────────────────────────────

  window.Trigger.installNavigationWatcher = function () {
    var origPush = history.pushState;
    var origReplace = history.replaceState;

    history.pushState = function () {
      origPush.apply(this, arguments);
      if (isRecording) {
        recordStep({ type: 'navigate', url: window.location.href, title: document.title, spa: true });
      }
    };

    history.replaceState = function () {
      origReplace.apply(this, arguments);
      if (isRecording) {
        recordStep({ type: 'navigate', url: window.location.href, title: document.title, spa: true });
      }
    };

    window.addEventListener('popstate', function () {
      if (isRecording) {
        recordStep({ type: 'navigate', url: window.location.href, title: document.title, spa: true });
      }
    });
  };

})();
