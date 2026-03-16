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
  var lastInputIsSensitive = false;
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

    var isSensitive = target.type === 'password' ||
      target.autocomplete === 'cc-number' ||
      target.autocomplete === 'cc-csc' ||
      (target.name && target.name.toLowerCase().indexOf('password') !== -1) ||
      (target.name && target.name.toLowerCase().indexOf('secret') !== -1);

    lastInputIsSensitive = isSensitive;

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
      lastInputIsSensitive = false;
      inputBuffer = '';
      return;
    }

    recordStep({
      type: 'input',
      target: window.Trigger.generateFingerprint(lastInputElement),
      value: lastInputIsSensitive ? '' : inputBuffer,
      sensitive: !!lastInputIsSensitive,
    });

    lastInputElement = null;
    lastInputIsSensitive = false;
    inputBuffer = '';
    clearTimeout(inputDebounceTimer);
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
