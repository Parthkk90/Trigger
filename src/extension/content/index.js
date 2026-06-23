/**
 * Trigger - Content Script Injector (Entry Point)
 * Injected into every page. Coordinates recording and replay
 * by listening to messages from the background service worker.
 */

import './fingerprint.js';

(function () {
  'use strict';

  const _browser = typeof browser !== 'undefined' ? browser : chrome;

  // Install SPA navigation hooks
  window.Trigger.installNavigationWatcher();

  var currentMode = 'idle';
  var replayHeartbeatInterval = null;
  var replayCredentials = {};

  // ── Page Bridge (slug resolver page ↔ extension) ───────────────

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data || {};

    if (data.type === 'FLOWLINK_PING') {
      window.postMessage({ type: 'FLOWLINK_PONG' }, '*');
      return;
    }

    if (data.type === 'FLOWLINK_REPLAY') {
      var workflow = data.workflow;
      _browser.runtime.sendMessage({
        type: 'START_REPLAY_INLINE',
        workflow: workflow,
      }).then(function (response) {
        if (!response) return;
        if (response.type === 'EXECUTE_STEP') {
          window.Trigger.showProgressBar(response.total);
          handleExecuteStep(response.step, response.index, response.total);
        }
      }).catch(function () {
        // Ignore bridge errors to avoid crashing host page.
      });
    }
  });

  // ── Message Listener ───────────────────────────────────────────

  _browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    switch (message.type) {
      case 'RECORDER_START':
        handleRecorderStart();
        sendResponse({ ok: true });
        break;

      case 'RECORDER_STOP':
        handleRecorderStop();
        sendResponse({ ok: true });
        break;

      case 'EXECUTE_STEP':
        handleExecuteStep(message.step, message.index, message.total);
        break;

      case 'REQUEST_CREDENTIALS':
        handleCredentialPrompt(message.prompts || []);
        sendResponse({ ok: true });
        break;

      case 'CHECK_DOM_DRIFT':
        handleDomDriftCheck(message.sampleSteps || [], message.threshold || 60);
        sendResponse({ ok: true });
        break;

      case 'REPLAY_COMPLETE':
        handleReplayComplete();
        sendResponse({ ok: true });
        break;

      case 'REPLAY_ABORT':
        handleReplayAbort();
        sendResponse({ ok: true });
        break;

      case 'EXECUTE_STEP_RECOVERY':
        _browser.runtime.sendMessage({ type: 'REPLAY_READY' }).then(function (response) {
          if (!response) return;
          if (response.type === 'EXECUTE_STEP') {
            window.Trigger.showProgressBar(response.total);
            handleExecuteStep(response.step, response.index, response.total);
          }
        }).catch(function () {});
        sendResponse({ ok: true });
        break;

      case 'SHOW_ASSIST':
        window.Trigger.showAssistPanel({
          step: message.step,
          index: message.index,
          total: message.total,
          reason: message.reason,
          reasonType: message.reasonType,
          retries: message.retries,
          maxRetries: message.maxRetries,
        });
        sendResponse({ ok: true });
        break;

      case 'PING':
        sendResponse({ ok: true, mode: currentMode });
        break;
    }
    return false;
  });

  // ── Recording ──────────────────────────────────────────────────

  function handleRecorderStart() {
    currentMode = 'recording';
    stopReplayHeartbeat();
    window.Trigger.startRecording();
    window.Trigger.createOverlay('recording');
  }

  function handleRecorderStop() {
    currentMode = 'idle';
    stopReplayHeartbeat();
    window.Trigger.stopRecording();
    window.Trigger.destroyOverlay();
  }

  // ── Replay ─────────────────────────────────────────────────────

  function handleExecuteStep(step, index, total) {
    if (currentMode !== 'replaying') {
      currentMode = 'replaying';
      window.Trigger.resetReplay();
      window.Trigger.createOverlay('replaying');
      window.Trigger.showProgressBar(total);
      startReplayHeartbeat();
    }

    window.Trigger.updateProgress(index, total, step);
    if (typeof window.Trigger.assistAttempting === 'function') {
      window.Trigger.assistAttempting({ index: index, total: total, step: step });
    }

    var preparedStep = applyCredentialSubstitution(step, index);

    window.Trigger.executeStep(preparedStep, index, total).then(function (result) {
      if (result.success) {
        if (typeof window.Trigger.assistResolved === 'function') {
          window.Trigger.assistResolved({ action: 'step_completed', index: index });
        }
        return _browser.runtime.sendMessage({
          type: 'STEP_COMPLETED',
          index: index,
        });
      } else {
        return _browser.runtime.sendMessage({
          type: 'STEP_FAILED',
          index: index,
          reason: result.reason,
          confidence: result.confidence,
          reasonType: result.reasonType,
        });
      }
    }).then(function (response) {
      if (!response) return;

      if (response.type === 'EXECUTE_STEP') {
        handleExecuteStep(response.step, response.index, response.total);
      } else if (response.type === 'REPLAY_COMPLETE') {
        if (typeof window.Trigger.assistResolved === 'function') {
          window.Trigger.assistResolved({ action: 'replay_complete', index: index });
        }
        handleReplayComplete();
      }
      // WAITING_NAVIGATION → do nothing, new page will call REPLAY_READY
    }).catch(function () {
      // Extension context invalidated
    });
  }

  function handleReplayComplete() {
    currentMode = 'idle';
    stopReplayHeartbeat();
    replayCredentials = {};
    window.Trigger.showCompletionToast();
    setTimeout(function () { window.Trigger.destroyOverlay(); }, 3000);
  }

  function handleReplayAbort() {
    currentMode = 'idle';
    stopReplayHeartbeat();
    replayCredentials = {};
    window.Trigger.abortReplay();
    window.Trigger.destroyOverlay();
  }

  function handleCredentialPrompt(prompts) {
    if (currentMode !== 'replaying') {
      currentMode = 'replaying';
      window.Trigger.createOverlay('replaying');
      startReplayHeartbeat();
    }

    window.Trigger.showCredentialPrompt({
      prompts: prompts,
      onSubmit: function (values) {
        replayCredentials = values || {};
        _browser.runtime.sendMessage({ type: 'SUBMIT_REPLAY_CREDENTIALS' }).then(function (response) {
          if (!response) return;
          if (response.type === 'EXECUTE_STEP') {
            window.Trigger.showProgressBar(response.total);
            handleExecuteStep(response.step, response.index, response.total);
          } else if (response.type === 'REPLAY_COMPLETE') {
            handleReplayComplete();
          }
        }).catch(function () {});
      },
      onCancel: function () {
        _browser.runtime.sendMessage({ type: 'STOP_REPLAY' }).catch(function () {});
      },
    });
  }

  function handleDomDriftCheck(sampleSteps, threshold) {
    if (currentMode !== 'replaying') {
      currentMode = 'replaying';
      window.Trigger.createOverlay('replaying');
      startReplayHeartbeat();
    }

    var report = window.Trigger.evaluateReplayFreshness(sampleSteps || []);
    if (report.averageConfidence >= threshold) {
      _browser.runtime.sendMessage({ type: 'DOM_DRIFT_DECISION', proceed: true }).then(function (response) {
        if (!response) return;
        if (response.type === 'EXECUTE_STEP') {
          window.Trigger.showProgressBar(response.total);
          handleExecuteStep(response.step, response.index, response.total);
        }
      }).catch(function () {});
      return;
    }

    window.Trigger.showDriftWarning({
      averageConfidence: report.averageConfidence,
      threshold: threshold,
      onProceed: function () {
        _browser.runtime.sendMessage({ type: 'DOM_DRIFT_DECISION', proceed: true }).then(function (response) {
          if (!response) return;
          if (response.type === 'EXECUTE_STEP') {
            window.Trigger.showProgressBar(response.total);
            handleExecuteStep(response.step, response.index, response.total);
          } else if (response.type === 'REPLAY_COMPLETE') {
            handleReplayComplete();
          }
        }).catch(function () {});
      },
      onCancel: function () {
        _browser.runtime.sendMessage({ type: 'DOM_DRIFT_DECISION', proceed: false }).catch(function () {});
      },
    });
  }

  function applyCredentialSubstitution(step, index) {
    if (!step || step.type !== 'input' || !step.sensitive) return step;
    var key = step._credentialKey;
    if (!key || !Object.prototype.hasOwnProperty.call(replayCredentials, key)) return step;

    return {
      ...step,
      sensitive: false,
      value: replayCredentials[key],
      _credentialInjected: true,
      _credentialIndex: index,
    };
  }

  function startReplayHeartbeat() {
    stopReplayHeartbeat();
    replayHeartbeatInterval = setInterval(function () {
      _browser.runtime.sendMessage({ type: 'REPLAY_HEARTBEAT' }).catch(function () {});
    }, 10000);
  }

  function stopReplayHeartbeat() {
    if (replayHeartbeatInterval) {
      clearInterval(replayHeartbeatInterval);
      replayHeartbeatInterval = null;
    }
  }

  // ── On page load: check if a replay is in progress ─────────────

  function checkIfReplaying() {
    _browser.runtime.sendMessage({ type: 'GET_STATE' }).then(function (state) {
      if (state && state.mode === 'replaying') {
        currentMode = 'replaying';
        window.Trigger.resetReplay();
        window.Trigger.createOverlay('replaying');

        return _browser.runtime.sendMessage({ type: 'REPLAY_READY' });
      }
    }).then(function (response) {
      if (!response) return;
      if (response.type === 'EXECUTE_STEP') {
        window.Trigger.showProgressBar(response.total);
        handleExecuteStep(response.step, response.index, response.total);
      } else if (response.type === 'REQUEST_CREDENTIALS') {
        handleCredentialPrompt(response.prompts || []);
      } else if (response.type === 'CHECK_DOM_DRIFT') {
        handleDomDriftCheck(response.sampleSteps || [], response.threshold || 60);
      } else if (response.type === 'REPLAY_COMPLETE') {
        handleReplayComplete();
      }
    }).catch(function () {
      // Extension context invalidated - normal on non-extension pages
    });
  }

  checkIfReplaying();

})();
