/**
 * Trigger - Recorder
 * Captures user interactions (click, type, navigate) as structured step objects.
 * Runs inside the content script during recording.
 */

(function () {
  'use strict';

  const _browser = typeof browser !== 'undefined' ? browser : chrome;

  window.Trigger = window.Trigger || {};

  var isRecording = false;
  var recorderPath = 'event-listener';
  var interactionListenersAttached = false;
  var spaNavigationListenersAttached = false;
  var mutationObserver = null;
  var hostileValueSnapshot = new WeakMap();
  var lastInputElement = null;
  var inputBuffer = '';
  var inputDebounceTimer = null;
  var SCREENSHOT_CAPTURE_TIMEOUT_MS = 1500;

  // ── Public API ─────────────────────────────────────────────────

  window.Trigger.startRecording = function () {
    if (isRecording) return;
    isRecording = true;

    attachRecordingObserversAndListeners();
    attachSpaNavigationListeners();

    console.log('[Trigger] Recorder path active:', recorderPath);

    recordStep({
      type: 'navigate',
      url: window.location.href,
      title: document.title,
    }, null);
  };

  window.Trigger.stopRecording = function () {
    if (!isRecording) return;
    isRecording = false;

    flushInputBuffer();

    detachInteractionListeners();
    deactivateMutationObserverRecorder();
    detachSpaNavigationListeners();
  };

  function attachRecordingObserversAndListeners(forceReattach) {
    if (forceReattach) {
      detachInteractionListeners();
      deactivateMutationObserverRecorder();
    }

    if (!interactionListenersAttached) {
      document.addEventListener('click', onClickCapture, true);
      document.addEventListener('input', onInputCapture, true);
      document.addEventListener('change', onChangeCapture, true);
      document.addEventListener('keydown', onKeydownCapture, true);
      interactionListenersAttached = true;
    }

    if (isHostileEnvironment()) {
      recorderPath = 'mutation-observer';
      activateMutationObserverRecorder();
    } else {
      recorderPath = 'event-listener';
      deactivateMutationObserverRecorder();
    }
  }

  function detachInteractionListeners() {
    if (!interactionListenersAttached) return;
    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('input', onInputCapture, true);
    document.removeEventListener('change', onChangeCapture, true);
    document.removeEventListener('keydown', onKeydownCapture, true);
    interactionListenersAttached = false;
  }

  function attachSpaNavigationListeners() {
    if (spaNavigationListenersAttached) return;
    document.addEventListener('turbo:load', onSpaNavigationEvent, true);
    document.addEventListener('turbo:render', onSpaNavigationEvent, true);
    window.addEventListener('popstate', onSpaNavigationEvent, true);
    spaNavigationListenersAttached = true;
  }

  function detachSpaNavigationListeners() {
    if (!spaNavigationListenersAttached) return;
    document.removeEventListener('turbo:load', onSpaNavigationEvent, true);
    document.removeEventListener('turbo:render', onSpaNavigationEvent, true);
    window.removeEventListener('popstate', onSpaNavigationEvent, true);
    spaNavigationListenersAttached = false;
  }

  function onSpaNavigationEvent() {
    if (!isRecording) return;
    // SPA transitions can replace key DOM nodes; re-bind hooks and observer safely.
    attachRecordingObserversAndListeners(true);
  }

  function isHostileEnvironment() {
    var host = (window.location.hostname || '').toLowerCase();
    var hostileHosts = ['instagram.com', 'facebook.com', 'twitter.com', 'x.com'];
    for (var i = 0; i < hostileHosts.length; i += 1) {
      var blocked = hostileHosts[i];
      if (host === blocked || host.endsWith('.' + blocked)) {
        return true;
      }
    }

    return computeClassNameEntropy() > 3.5;
  }

  function computeClassNameEntropy() {
    var samples = [];
    var nodes = document.querySelectorAll('[class]');
    for (var i = 0; i < nodes.length && samples.length < 120; i += 1) {
      var raw = String(nodes[i].className || '').trim();
      if (!raw) continue;
      samples.push(raw);
    }

    if (samples.length === 0) return 0;

    var corpus = samples.join(' ');
    var freq = {};
    for (var j = 0; j < corpus.length; j += 1) {
      var ch = corpus[j];
      freq[ch] = (freq[ch] || 0) + 1;
    }

    var entropy = 0;
    var total = corpus.length;
    var keys = Object.keys(freq);
    for (var k = 0; k < keys.length; k += 1) {
      var p = freq[keys[k]] / total;
      entropy += -p * Math.log2(p);
    }
    return entropy;
  }

  function activateMutationObserverRecorder() {
    deactivateMutationObserverRecorder();

    mutationObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var mutation = mutations[i];
        var target = mutation.target;
        if (!target || target.closest && target.closest('#trigger-overlay')) continue;

        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          handleMutationInputTarget(target);
        } else if (target instanceof HTMLSelectElement) {
          handleMutationSelectTarget(target);
        }

        if (mutation.type === 'childList') {
          for (var a = 0; a < mutation.addedNodes.length; a += 1) {
            var added = mutation.addedNodes[a];
            if (!added || added.nodeType !== 1) continue;
            if (added.matches && added.matches('input,textarea,select')) {
              hostileValueSnapshot.set(added, getNodeSnapshotValue(added));
            }
            if (added.querySelectorAll) {
              var formNodes = added.querySelectorAll('input,textarea,select');
              formNodes.forEach(function (node) {
                hostileValueSnapshot.set(node, getNodeSnapshotValue(node));
              });
            }
          }
        }
      }
    });

    mutationObserver.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['value', 'checked', 'selected'],
    });
  }

  function deactivateMutationObserverRecorder() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  function getNodeSnapshotValue(node) {
    if (!node) return '';
    if (node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio')) {
      return node.checked ? '1' : '0';
    }
    return String(node.value || '');
  }

  function handleMutationInputTarget(target) {
    var prev = hostileValueSnapshot.get(target);
    var next = getNodeSnapshotValue(target);
    if (prev === next) return;

    hostileValueSnapshot.set(target, next);

    if (target.type === 'checkbox' || target.type === 'radio') {
      recordStep({
        type: 'check',
        target: window.Trigger.generateFingerprint(target),
        checked: target.checked,
      }, target);
      return;
    }

    var sensitive = isSensitiveInputTarget(target) || looksSensitiveValue(next);
    recordStep({
      type: 'input',
      target: window.Trigger.generateFingerprint(target),
      value: sensitive ? '' : next,
      sensitive: !!sensitive,
    }, target);
  }

  function handleMutationSelectTarget(target) {
    var prev = hostileValueSnapshot.get(target);
    var next = getNodeSnapshotValue(target);
    if (prev === next) return;

    hostileValueSnapshot.set(target, next);
    recordStep({
      type: 'select',
      target: window.Trigger.generateFingerprint(target),
      value: target.value,
      selectedText: target.options[target.selectedIndex] ? target.options[target.selectedIndex].text : '',
    }, target);
  }

  // ── Event Handlers ─────────────────────────────────────────────

  function findMeaningfulTarget(path) {
    if (!path || path.length === 0) return null;

    for (var i = 0; i < path.length; i += 1) {
      var node = path[i];
      if (!node || node.nodeType !== 1) continue; // Skip non-elements

      var tagName = node.tagName.toLowerCase();
      var role = node.getAttribute('role');

      // Prioritize standard interactive elements.
      if (
        tagName === 'a' ||
        tagName === 'button' ||
        tagName === 'input' ||
        tagName === 'select' ||
        tagName === 'textarea'
      ) {
        return node;
      }

      // Check for common ARIA roles that denote interactivity.
      if (
        role === 'button' ||
        role === 'link' ||
        role === 'checkbox' ||
        role === 'radio' ||
        role === 'tab' ||
        role === 'menuitem' ||
        role === 'option' ||
        role === 'switch'
      ) {
        return node;
      }

      // Check if it has an explicit onclick handler
      if (node.hasAttribute('onclick')) {
        return node;
      }

      // Stop if we hit the document body or HTML tag.
      if (tagName === 'body' || tagName === 'html') break;
    }

    // Fallback: If no clearly interactive element is found, return the original
    // top-most element from the path, ensuring it's an element.
    var fallback = path[0];
    if (fallback && fallback.nodeType === 3) {
      return fallback.parentElement;
    }
    return fallback && fallback.nodeType === 1 ? fallback : null;
  }

  function onClickCapture(event) {
    var path = (event.composedPath && event.composedPath()) || (event.target ? [event.target] : []);
    var target = findMeaningfulTarget(path);
    
    if (!target || target.nodeType !== 1 || target === document.body || target === document.documentElement) return;
    if (target.closest && target.closest('#trigger-overlay')) return;

    if (lastInputElement && lastInputElement !== target) {
      flushInputBuffer();
    }

    var fingerprint = window.Trigger.generateFingerprint(target);

    var anchor = target.closest('a');
    var willNavigate = anchor && anchor.href && anchor.href.indexOf('javascript:') !== 0;

    var step = { type: 'click', target: fingerprint };
    if (willNavigate) step.navigatesTo = anchor.href;

    recordStep(step, target);
  }

  function onInputCapture(event) {
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!target || target.nodeType !== 1 || (target.closest && target.closest('#trigger-overlay'))) return;

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
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!target || target.nodeType !== 1 || (target.closest && target.closest('#trigger-overlay'))) return;

    var tag = target.tagName.toLowerCase();

    if (tag === 'select') {
      recordStep({
        type: 'select',
        target: window.Trigger.generateFingerprint(target),
        value: target.value,
        selectedText: target.options[target.selectedIndex] ? target.options[target.selectedIndex].text : '',
      }, target);
    } else if (target.type === 'checkbox' || target.type === 'radio') {
      recordStep({
        type: 'check',
        target: window.Trigger.generateFingerprint(target),
        checked: target.checked,
      }, target);
    }
  }

  function onKeydownCapture(event) {
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
      var target = (event.composedPath && event.composedPath()[0]) || event.target;
      if (target && target.nodeType === 3) target = target.parentElement;
      if (target && target.nodeType === 1 && target !== document.body) {
        if (isSensitiveInputTarget(target)) {
          if (event.key === 'Enter' || event.key === 'Tab') flushInputBuffer();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') flushInputBuffer();
        recordStep({
          type: 'keypress',
          target: window.Trigger.generateFingerprint(target),
          key: event.key,
        }, target);
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
    }, lastInputElement);

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

  function recordStep(step, targetElement) {
    var capturePromise = tryCaptureScreenshotAnchor(targetElement);
    if (!capturePromise) {
      dispatchRecordedStep(step);
      return;
    }

    capturePromise.then(function (anchor) {
      if (anchor) {
        step.screenshotAnchor = anchor;
      }
      dispatchRecordedStep(step);
    }).catch(function () {
      // Screenshot anchors are optional; never block recording.
      dispatchRecordedStep(step);
    });
  }

  function dispatchRecordedStep(step) {
    console.log('[Trigger] Recording step:', step);
    _browser.runtime.sendMessage({ type: 'RECORD_STEP', step: step }).catch(function (err) {
      console.error('[Trigger] Failed to send RECORD_STEP:', err);
    });
  }

  function tryCaptureScreenshotAnchor(targetElement) {
    if (!targetElement || !targetElement.getBoundingClientRect) {
      return null;
    }

    if (typeof window.html2canvas === 'function') {
      return withTimeout(captureWithHtml2Canvas(targetElement), SCREENSHOT_CAPTURE_TIMEOUT_MS);
    }

    if (
      window.Trigger &&
      window.Trigger.enableDisplayMediaCapture === true &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === 'function'
    ) {
      return withTimeout(captureWithDisplayMedia(targetElement), SCREENSHOT_CAPTURE_TIMEOUT_MS);
    }

    return null;
  }

  function captureWithHtml2Canvas(targetElement) {
    var rect = targetElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return Promise.resolve(null);

    return window.html2canvas(document.body, {
      useCORS: true,
      backgroundColor: null,
      logging: false,
      x: Math.max(0, Math.floor(rect.left + window.scrollX)),
      y: Math.max(0, Math.floor(rect.top + window.scrollY)),
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    }).then(function (canvas) {
      if (!canvas || typeof canvas.toDataURL !== 'function') return null;
      return canvas.toDataURL('image/png');
    });
  }

  function captureWithDisplayMedia(targetElement) {
    var rect = targetElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return Promise.resolve(null);

    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
      var video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;

      return video.play().then(function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(rect.width));
        canvas.height = Math.max(1, Math.floor(rect.height));

        var ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, rect.left, rect.top, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      }).finally(function () {
        stream.getTracks().forEach(function (track) { track.stop(); });
      });
    }).catch(function () {
      return null;
    });
  }

  function withTimeout(promise, timeoutMs) {
    if (!promise || typeof promise.then !== 'function') return Promise.resolve(null);

    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve(null); }, timeoutMs);
      }),
    ]);
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
