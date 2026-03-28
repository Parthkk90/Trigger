/**
 * Trigger — Replay Engine
 * Executes recorded steps in the browser with ghost cursor visualization.
 * Confidence-based: auto (85+), assisted (50-84), manual (<50).
 */

(function () {
  'use strict';

  window.Trigger = window.Trigger || {};

  var STEP_DELAY_MS = 300;
  var ELEMENT_WAIT_MS = 5000;
  var ELEMENT_POLL_MS = 200;

  var aborted = false;
  var ghostCursorEl = null;

  // ── Public API ─────────────────────────────────────────────────

  window.Trigger.executeStep = function (step, index, total) {
    if (aborted) return Promise.reject(new Error('Replay aborted'));

    if (step.type === 'navigate') {
      if (step.spa) {
        return waitForUrl(step.url, 5000).then(function () {
          return { success: true };
        });
      }
      return Promise.resolve({ success: true });
    }

    return waitForElement(step.target).then(function (result) {
      if (!result.element) {
        return {
          success: false,
          confidence: 0,
          reason: 'Element not found after waiting',
          reasonType: 'selector_not_found',
        };
      }

      return animateGhostCursor(result.element).then(function () {
        if (result.confidence < window.Trigger.CONFIDENCE_SHOW) {
          return {
            success: false,
            confidence: result.confidence,
            reason: 'Low confidence match (' + result.confidence + '%)',
            reasonType: 'selector_not_found',
            element: result.element,
          };
        }

        return performAction(step, result.element).then(function () {
          if (result.confidence < window.Trigger.CONFIDENCE_AUTO) {
            highlightElement(result.element, 'rgba(59, 130, 246, 0.3)', 800);
          }
          return sleep(step.waitAfter || STEP_DELAY_MS);
        }).then(function () {
          return { success: true, confidence: result.confidence };
        });
      });
    }).catch(function (err) {
      var msg = err && err.message ? err.message : 'Unknown replay error';
      return {
        success: false,
        confidence: 0,
        reason: msg,
        reasonType: classifyReplayErrorType(msg),
      };
    });
  };

  window.Trigger.abortReplay = function () {
    aborted = true;
    removeGhostCursor();
    removeAllHighlights();
  };

  window.Trigger.resetReplay = function () {
    aborted = false;
  };

  // ── Action Execution ───────────────────────────────────────────

  function performAction(step, element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    return sleep(200).then(function () {
      switch (step.type) {
        case 'click':
          simulateClick(element);
          return Promise.resolve();

        case 'input':
          return simulateInput(element, step.value, step.sensitive);

        case 'select':
          simulateSelect(element, step.value);
          return Promise.resolve();

        case 'check':
          if (element.checked !== step.checked) simulateClick(element);
          return Promise.resolve();

        case 'keypress':
          simulateKeypress(element, step.key);
          return Promise.resolve();

        default:
          return Promise.reject(new Error('Unknown step type: ' + step.type));
      }
    });
  }

  function simulateClick(element) {
    var rect = element.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    element.dispatchEvent(new MouseEvent('mousedown', opts));
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    element.dispatchEvent(new MouseEvent('click', opts));

    if (typeof element.click === 'function') {
      element.click();
    }
  }

  function simulateInput(element, value, isSensitive) {
    if (isSensitive) {
      element.focus();
      return Promise.resolve();
    }

    element.focus();

    // Use native setter to work with React and Vue
    var nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(element, '');
    } else {
      element.value = '';
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));

    var chars = value.split('');
    var i = 0;

    function typeNext() {
      if (i >= chars.length || aborted) return Promise.resolve();

      if (nativeSetter) {
        nativeSetter.call(element, element.value + chars[i]);
      } else {
        element.value += chars[i];
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      i++;

      return sleep(30 + Math.random() * 40).then(typeNext);
    }

    return typeNext().then(function () {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function simulateSelect(element, value) {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function simulateKeypress(element, key) {
    var opts = { key: key, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', opts));
    element.dispatchEvent(new KeyboardEvent('keypress', opts));
    element.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ── Element Waiting ────────────────────────────────────────────

  function waitForElement(fingerprint, timeout) {
    timeout = timeout || ELEMENT_WAIT_MS;
    var deadline = Date.now() + timeout;

    function poll() {
      if (aborted) return Promise.reject(new Error('Replay aborted'));
      if (Date.now() >= deadline) {
        return Promise.resolve(window.Trigger.resolveFingerprint(fingerprint));
      }
      var result = window.Trigger.resolveFingerprint(fingerprint);
      if (result.element && result.confidence >= window.Trigger.CONFIDENCE_SHOW) {
        return Promise.resolve(result);
      }
      return sleep(ELEMENT_POLL_MS).then(poll);
    }

    return poll();
  }

  function waitForUrl(expectedUrl, timeout) {
    var deadline = Date.now() + timeout;
    function poll() {
      if (window.location.href === expectedUrl) return Promise.resolve();
      if (Date.now() >= deadline) {
        return Promise.reject(new Error('Navigation timeout waiting for ' + expectedUrl));
      }
      return sleep(200).then(poll);
    }
    return poll();
  }

  function classifyReplayErrorType(message) {
    var text = String(message || '').toLowerCase();
    if (text.indexOf('not found') !== -1 || text.indexOf('confidence') !== -1) return 'selector_not_found';
    if (text.indexOf('timeout') !== -1) return 'navigation_timeout';
    if (text.indexOf('aborted') !== -1) return 'aborted';
    if (text.indexOf('permission') !== -1 || text.indexOf('denied') !== -1) return 'permission_error';
    if (text.indexOf('unknown step') !== -1) return 'action_error';
    return 'unknown_error';
  }

  // ── Ghost Cursor ───────────────────────────────────────────────

  function ensureGhostCursor() {
    if (ghostCursorEl) return ghostCursorEl;

    ghostCursorEl = document.createElement('div');
    ghostCursorEl.id = 'trigger-ghost-cursor';
    ghostCursorEl.innerHTML =
      '<div style="width:20px;height:20px;border-radius:50%;background:rgba(99,102,241,0.7);' +
      'border:2px solid rgba(99,102,241,0.9);box-shadow:0 0 12px rgba(99,102,241,0.4);' +
      'pointer-events:none;transition:all .3s cubic-bezier(.4,0,.2,1)"></div>' +
      '<div style="position:absolute;top:24px;left:12px;font-size:11px;' +
      'font-family:-apple-system,system-ui,sans-serif;color:#6366f1;font-weight:600;' +
      'white-space:nowrap;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.1)">Trigger</div>';

    ghostCursorEl.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;' +
      'transform:translate(-10px,-10px);' +
      'transition:left .3s cubic-bezier(.4,0,.2,1),top .3s cubic-bezier(.4,0,.2,1);';

    document.body.appendChild(ghostCursorEl);
    return ghostCursorEl;
  }

  function animateGhostCursor(targetElement) {
    var cursor = ensureGhostCursor();
    var rect = targetElement.getBoundingClientRect();
    var targetX = rect.left + rect.width / 2;
    var targetY = rect.top + rect.height / 2;

    cursor.style.left = targetX + 'px';
    cursor.style.top = targetY + 'px';
    cursor.style.opacity = '1';

    return sleep(350).then(function () {
      var dot = cursor.firstElementChild;
      dot.style.transform = 'scale(1.5)';
      return sleep(100);
    }).then(function () {
      var dot = cursor.firstElementChild;
      dot.style.transform = 'scale(1)';
      return sleep(100);
    });
  }

  function removeGhostCursor() {
    if (ghostCursorEl) {
      ghostCursorEl.remove();
      ghostCursorEl = null;
    }
  }

  // ── Element Highlighting ───────────────────────────────────────

  function highlightElement(element, color, durationMs) {
    var overlay = document.createElement('div');
    overlay.className = 'trigger-highlight';
    var rect = element.getBoundingClientRect();
    overlay.style.cssText =
      'position:fixed;left:' + (rect.left - 3) + 'px;top:' + (rect.top - 3) + 'px;' +
      'width:' + (rect.width + 6) + 'px;height:' + (rect.height + 6) + 'px;' +
      'border:2px solid ' + color + ';border-radius:4px;background:' + color + ';' +
      'pointer-events:none;z-index:2147483645;transition:opacity .3s';
    document.body.appendChild(overlay);
    setTimeout(function () {
      overlay.style.opacity = '0';
      setTimeout(function () { overlay.remove(); }, 300);
    }, durationMs);
  }

  function removeAllHighlights() {
    document.querySelectorAll('.trigger-highlight').forEach(function (el) { el.remove(); });
  }

  // ── Utilities ──────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

})();
