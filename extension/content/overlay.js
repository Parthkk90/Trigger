/**
 * Trigger — Overlay UI
 * Injects floating UI into the page during recording and replay.
 * Uses Shadow DOM for style isolation from the host page.
 */

(function () {
  'use strict';

  window.Trigger = window.Trigger || {};

  var overlayRoot = null;

  // ── Overlay Container ──────────────────────────────────────────

  window.Trigger.createOverlay = function (mode) {
    window.Trigger.destroyOverlay();

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'trigger-overlay';
    overlayRoot.setAttribute('style',
      'all:initial;position:fixed;top:0;left:0;width:100%;z-index:2147483647;pointer-events:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;'
    );

    var shadow = overlayRoot.attachShadow({ mode: 'open' });
    shadow.innerHTML = OVERLAY_HTML;

    document.documentElement.appendChild(overlayRoot);

    var bar = shadow.getElementById('trigger-bar');

    if (mode === 'recording') {
      bar.className = 'trigger-bar recording';
      bar.innerHTML =
        '<div class="recording-dot"></div>' +
        '<span>Recording</span>' +
        '<button class="stop-btn" id="trigger-stop">Stop</button>';
      bar.style.display = 'flex';

      shadow.getElementById('trigger-stop').addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        window.Trigger.destroyOverlay();
      });

    } else if (mode === 'replaying') {
      bar.className = 'trigger-bar replaying';
      bar.innerHTML =
        '<span id="trigger-status">Starting replay...</span>' +
        '<div class="progress-container">' +
          '<div class="progress-track">' +
            '<div class="progress-fill" id="trigger-progress" style="width:0%"></div>' +
          '</div>' +
        '</div>' +
        '<div class="step-label" id="trigger-step-label"></div>' +
        '<button class="stop-btn" id="trigger-stop" title="Emergency Stop (Esc)">\u25A0 Stop</button>';
      bar.style.display = 'flex';

      shadow.getElementById('trigger-stop').addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'STOP_REPLAY' });
      });

      document.addEventListener('keydown', emergencyStopHandler);
    }
  };

  function emergencyStopHandler(e) {
    if (e.key === 'Escape') {
      chrome.runtime.sendMessage({ type: 'STOP_REPLAY' });
      document.removeEventListener('keydown', emergencyStopHandler);
    }
  }

  window.Trigger.destroyOverlay = function () {
    document.removeEventListener('keydown', emergencyStopHandler);
    if (overlayRoot) {
      overlayRoot.remove();
      overlayRoot = null;
    }
  };

  // ── Progress ───────────────────────────────────────────────────

  window.Trigger.showProgressBar = function (total) {
    if (!overlayRoot) return;
    var shadow = overlayRoot.shadowRoot;
    var status = shadow && shadow.getElementById('trigger-status');
    if (status) status.textContent = '0 / ' + total;
  };

  window.Trigger.updateProgress = function (index, total, step) {
    if (!overlayRoot) return;
    var shadow = overlayRoot.shadowRoot;
    if (!shadow) return;

    var progress = shadow.getElementById('trigger-progress');
    var status = shadow.getElementById('trigger-status');
    var label = shadow.getElementById('trigger-step-label');

    if (progress) progress.style.width = (((index + 1) / total) * 100) + '%';
    if (status) status.textContent = (index + 1) + ' / ' + total;
    if (label) label.textContent = describeStep(step);
  };

  function describeStep(step) {
    switch (step.type) {
      case 'click':
        return 'Click "' + (step.target && (step.target.text || step.target.ariaLabel) || 'element') + '"';
      case 'input':
        return 'Type into ' + (step.target && (step.target.placeholder || step.target.name) || 'field');
      case 'navigate':
        return 'Navigate to ' + (step.title || step.url || 'page');
      case 'select':
        return 'Select "' + (step.selectedText || step.value) + '"';
      case 'check':
        return step.checked ? 'Check checkbox' : 'Uncheck checkbox';
      case 'keypress':
        return 'Press ' + step.key;
      default:
        return step.type;
    }
  }

  // ── Assist Panel ───────────────────────────────────────────────

  window.Trigger.showAssistPanel = function (step, index, total, reason) {
    if (!overlayRoot) window.Trigger.createOverlay('replaying');
    var shadow = overlayRoot.shadowRoot;
    if (!shadow) return;

    var assist = shadow.getElementById('trigger-assist');
    assist.innerHTML =
      '<div class="assist-title">Step ' + (index + 1) + ' of ' + total + '</div>' +
      '<div class="assist-desc">' +
        describeStep(step) + '<br>' +
        '<small style="color:#9ca3af">' + escapeHtml(reason) + '</small>' +
      '</div>' +
      '<div class="assist-actions">' +
        '<button class="assist-btn secondary" id="assist-skip">Skip this step</button>' +
        '<button class="assist-btn primary" id="assist-retry">Retry</button>' +
      '</div>';
    assist.style.display = 'block';

    shadow.getElementById('assist-skip').addEventListener('click', function () {
      assist.style.display = 'none';
      chrome.runtime.sendMessage({ type: 'STEP_COMPLETED', index: index });
    });

    shadow.getElementById('assist-retry').addEventListener('click', function () {
      assist.style.display = 'none';
      chrome.runtime.sendMessage({ type: 'REPLAY_READY' });
    });
  };

  // ── Toasts ─────────────────────────────────────────────────────

  window.Trigger.showCompletionToast = function () {
    showToast('\u2713 Workflow complete', 'success');
  };

  window.Trigger.showErrorToast = function (message) {
    showToast(message || 'Step failed', 'error');
  };

  function showToast(text, type) {
    if (!overlayRoot) {
      window.Trigger.createOverlay('replaying');
    }
    var shadow = overlayRoot.shadowRoot;
    var toast = shadow && shadow.getElementById('trigger-toast');
    if (toast) {
      toast.className = 'toast ' + type;
      toast.textContent = text;
      toast.style.display = 'block';
      setTimeout(function () { toast.style.display = 'none'; }, 3000);
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Stylesheet + Template ──────────────────────────────────────

  var OVERLAY_HTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    '.trigger-bar{position:fixed;top:8px;right:8px;display:flex;align-items:center;gap:8px;' +
      'padding:8px 14px;border-radius:10px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
      'font-size:13px;color:#fff;pointer-events:auto;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.25);transition:all .3s ease;z-index:2147483647}' +
    '.trigger-bar.recording{background:#dc2626}' +
    '.trigger-bar.replaying{background:#4f46e5}' +
    '.recording-dot{width:8px;height:8px;border-radius:50%;background:#fff;animation:pulse 1s infinite}' +
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}' +
    '.progress-container{display:flex;align-items:center;gap:8px}' +
    '.progress-track{width:120px;height:4px;background:rgba(255,255,255,.3);border-radius:2px;overflow:hidden}' +
    '.progress-fill{height:100%;background:#fff;border-radius:2px;transition:width .3s ease}' +
    '.step-label{font-size:11px;opacity:.9;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.stop-btn{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:#fff;' +
      'border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;' +
      'pointer-events:auto;transition:background .15s}' +
    '.stop-btn:hover{background:rgba(255,255,255,.35)}' +
    '.assist-panel{position:fixed;bottom:20px;right:20px;width:320px;background:#fff;border-radius:12px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.2);padding:16px;pointer-events:auto;z-index:2147483647;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}' +
    '.assist-title{font-size:14px;font-weight:700;color:#1e1b4b;margin-bottom:4px}' +
    '.assist-desc{font-size:12px;color:#6b7280;margin-bottom:12px;line-height:1.4}' +
    '.assist-actions{display:flex;gap:8px}' +
    '.assist-btn{flex:1;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;' +
      'cursor:pointer;border:none;transition:background .15s}' +
    '.assist-btn.primary{background:#4f46e5;color:#fff}' +
    '.assist-btn.primary:hover{background:#4338ca}' +
    '.assist-btn.secondary{background:#f3f4f6;color:#374151}' +
    '.assist-btn.secondary:hover{background:#e5e7eb}' +
    '.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:10px;font-size:13px;' +
      'font-weight:600;pointer-events:auto;box-shadow:0 4px 20px rgba(0,0,0,.2);' +
      'animation:slideUp .3s ease;z-index:2147483647;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}' +
    '.toast.success{background:#059669;color:#fff}' +
    '.toast.error{background:#dc2626;color:#fff}' +
    '@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}' +
    '</style>' +
    '<div id="trigger-bar" class="trigger-bar" style="display:none"></div>' +
    '<div id="trigger-assist" class="assist-panel" style="display:none"></div>' +
    '<div id="trigger-toast" class="toast" style="display:none"></div>';

})();
