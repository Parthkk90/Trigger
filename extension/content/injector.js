/**
 * Trigger — Content Script Injector (Entry Point)
 * Injected into every page. Coordinates recording and replay
 * by listening to messages from the background service worker.
 */

(function () {
  'use strict';

  // Install SPA navigation hooks
  window.Trigger.installNavigationWatcher();

  var currentMode = 'idle';
  var replayHeartbeatInterval = null;

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
      chrome.runtime.sendMessage({
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

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
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

      case 'REPLAY_COMPLETE':
        handleReplayComplete();
        sendResponse({ ok: true });
        break;

      case 'REPLAY_ABORT':
        handleReplayAbort();
        sendResponse({ ok: true });
        break;

      case 'EXECUTE_STEP_RECOVERY':
        chrome.runtime.sendMessage({ type: 'REPLAY_READY' }).then(function (response) {
          if (!response) return;
          if (response.type === 'EXECUTE_STEP') {
            window.Trigger.showProgressBar(response.total);
            handleExecuteStep(response.step, response.index, response.total);
          }
        }).catch(function () {});
        sendResponse({ ok: true });
        break;

      case 'SHOW_ASSIST':
        window.Trigger.showAssistPanel(message.step, message.index, message.total, message.reason);
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

    window.Trigger.executeStep(step, index, total).then(function (result) {
      if (result.success) {
        return chrome.runtime.sendMessage({
          type: 'STEP_COMPLETED',
          index: index,
        });
      } else {
        return chrome.runtime.sendMessage({
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
    window.Trigger.showCompletionToast();
    setTimeout(function () { window.Trigger.destroyOverlay(); }, 3000);
  }

  function handleReplayAbort() {
    currentMode = 'idle';
    stopReplayHeartbeat();
    window.Trigger.abortReplay();
    window.Trigger.destroyOverlay();
  }

  function startReplayHeartbeat() {
    stopReplayHeartbeat();
    replayHeartbeatInterval = setInterval(function () {
      chrome.runtime.sendMessage({ type: 'REPLAY_HEARTBEAT' }).catch(function () {});
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
    chrome.runtime.sendMessage({ type: 'GET_STATE' }).then(function (state) {
      if (state && state.mode === 'replaying') {
        currentMode = 'replaying';
        window.Trigger.resetReplay();
        window.Trigger.createOverlay('replaying');

        return chrome.runtime.sendMessage({ type: 'REPLAY_READY' });
      }
    }).then(function (response) {
      if (!response) return;
      if (response.type === 'EXECUTE_STEP') {
        window.Trigger.showProgressBar(response.total);
        handleExecuteStep(response.step, response.index, response.total);
      } else if (response.type === 'REPLAY_COMPLETE') {
        handleReplayComplete();
      }
    }).catch(function () {
      // Extension context invalidated — normal on non-extension pages
    });
  }

  checkIfReplaying();

})();
