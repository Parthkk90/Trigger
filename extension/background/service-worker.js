/**
 * Trigger — Background Service Worker
 * Coordinates recording/replay state across tabs and content scripts.
 * Implements keepalive to survive MV3 service worker termination.
 */

// ── State ──────────────────────────────────────────────────────────
let state = {
  mode: 'idle',        // 'idle' | 'recording' | 'replaying'
  activeTabId: null,
  workflowId: null,
  steps: [],
  replayIndex: 0,
};

const DEFAULT_API_BASE_URL = 'http://localhost:8787';
let backendUrlCache = DEFAULT_API_BASE_URL;

// ── MV3 Keepalive ──────────────────────────────────────────────────
// Service workers die after ~30s of inactivity in MV3.
// During active recording/replay, we ping to stay alive.
let keepaliveInterval = null;

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    // Any chrome API call resets the termination timer
    chrome.storage.session.get('keepalive');
  }, 20000);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

// ── Persist state to survive service worker restart ────────────────
async function persistState() {
  await chrome.storage.session.set({ triggerState: state });
}

async function restoreState() {
  const result = await chrome.storage.session.get('triggerState');
  if (result.triggerState) {
    state = result.triggerState;
    if (state.mode !== 'idle') {
      startKeepalive();
    }
  }
}

// Reads backend URL from sync storage with safe localhost fallback.
async function getBackendBaseUrl() {
  if (backendUrlCache && backendUrlCache !== DEFAULT_API_BASE_URL) {
    return backendUrlCache;
  }
  const result = await chrome.storage.sync.get('backendUrl');
  const configured = sanitizeUrl(result.backendUrl);
  backendUrlCache = configured || DEFAULT_API_BASE_URL;
  return backendUrlCache;
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (err) {
    return null;
  }
}

function validateReplayWorkflow(workflow) {
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

// Restore on startup
restoreState();

// ── Message Router ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.type];
  if (handler) {
    // Support async handlers
    const result = handler(message, sender);
    if (result instanceof Promise) {
      result.then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
      });
      return true; // keep channel open for async response
    }
    sendResponse(result);
  }
  return false;
});

const messageHandlers = {
  // ── Recording ──
  'START_RECORDING': async (msg, sender) => {
    state.mode = 'recording';
    state.activeTabId = sender.tab?.id ?? msg.tabId;
    state.steps = [];
    state.workflowId = generateId();
    startKeepalive();
    await persistState();

    // Notify content script to activate recorder
    try {
      await chrome.tabs.sendMessage(state.activeTabId, {
        type: 'RECORDER_START',
      });
      console.log(`[Trigger] Recording started on tab ${state.activeTabId}`);
    } catch (err) {
      console.error(`[Trigger] Failed to start recording on tab ${state.activeTabId}:`, err);
    }

    return { status: 'recording', workflowId: state.workflowId };
  },

  'STOP_RECORDING': async () => {
    console.log('[Trigger] Stopping recording. Recorded', state.steps.length, 'steps');
    const workflow = {
      id: state.workflowId,
      name: `Workflow ${new Date().toLocaleString()}`,
      startUrl: state.steps[0]?.url ?? '',
      steps: state.steps,
      createdAt: Date.now(),
    };

    console.log('[Trigger] Saving workflow:', workflow);

    // Save to local storage
    await saveWorkflow(workflow);

    // Mirror to backend to generate a real shareable link.
    try {
      const remote = await uploadWorkflowRemote(workflow);
      if (remote && remote.shareUrl) {
        workflow.shareUrl = remote.shareUrl;
        workflow.slug = remote.slug;
        await saveWorkflow(workflow);
      }
    } catch (err) {
      console.warn('[Trigger] Remote upload failed, keeping local copy only:', err.message);
    }

    // Save tab ID before clearing state
    const tabId = state.activeTabId;

    state.mode = 'idle';
    state.activeTabId = null;
    stopKeepalive();
    await persistState();

    // Notify content script to deactivate recorder
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'RECORDER_STOP',
      }).catch(() => {}); // tab might be closed
    }

    return { status: 'stopped', workflow };
  },

  'RECORD_STEP': async (msg, sender) => {
    if (state.mode !== 'recording') {
      console.warn('[Trigger] Ignoring RECORD_STEP: not in recording mode (mode=' + state.mode + ')');
      return { error: 'not recording' };
    }

    const step = {
      index: state.steps.length,
      timestamp: Date.now(),
      url: sender.tab?.url ?? '',
      ...msg.step,
    };

    console.log('[Trigger] Recorded step:', step);
    state.steps.push(step);
    await persistState();

    return { status: 'recorded', index: step.index };
  },

  // ── Replay ──
  'START_REPLAY': async (msg) => {
    const workflow = await loadWorkflow(msg.workflowId);
    if (!workflow) return { error: 'workflow not found' };
    const validation = validateReplayWorkflow(workflow);
    if (!validation.valid) return { error: validation.error };

    state.mode = 'replaying';
    state.workflowId = msg.workflowId;
    state.steps = workflow.steps;
    state.replayIndex = 0;
    startKeepalive();
    await persistState();

    // Open starting URL in a new tab
    const tab = await chrome.tabs.create({ url: workflow.startUrl });
    state.activeTabId = tab.id;
    await persistState();

    // Content script will request first step when ready
    return { status: 'replaying', totalSteps: workflow.steps.length };
  },

  'START_REPLAY_INLINE': async (msg, sender) => {
    const workflow = msg.workflow;
    const validation = validateReplayWorkflow(workflow);
    if (!validation.valid) return { error: validation.error };

    if (!sender.tab?.id) {
      return { error: 'inline replay requires sender tab' };
    }

    state.mode = 'replaying';
    state.workflowId = workflow.id || generateId();
    state.steps = workflow.steps;
    state.replayIndex = 0;
    state.activeTabId = sender.tab.id;
    startKeepalive();
    await persistState();

    if (workflow.startUrl && sender.tab.url !== workflow.startUrl) {
      await chrome.tabs.update(sender.tab.id, { url: workflow.startUrl });
      return { type: 'WAITING_NAVIGATION' };
    }

    const firstStep = state.steps[0];
    if (!firstStep) return { type: 'REPLAY_COMPLETE' };
    return { type: 'EXECUTE_STEP', step: firstStep, index: 0, total: state.steps.length };
  },

  'REPLAY_READY': async (msg, sender) => {
    // Content script reports it's loaded and ready for next step
    if (state.mode !== 'replaying') return { error: 'not replaying' };
    if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

    const step = state.steps[state.replayIndex];
    if (!step) {
      return { type: 'REPLAY_COMPLETE' };
    }

    return { type: 'EXECUTE_STEP', step, index: state.replayIndex, total: state.steps.length };
  },

  'STEP_COMPLETED': async (msg) => {
    if (state.mode !== 'replaying') return { error: 'not replaying' };

    state.replayIndex = msg.index + 1;
    await persistState();

    if (state.replayIndex >= state.steps.length) {
      state.mode = 'idle';
      stopKeepalive();
      await persistState();
      return { type: 'REPLAY_COMPLETE' };
    }

    const nextStep = state.steps[state.replayIndex];

    // If next step is on a different URL, navigate there
    // Content script will send REPLAY_READY when the new page loads
    if (nextStep.type === 'navigate') {
      chrome.tabs.update(state.activeTabId, { url: nextStep.url });
      return { type: 'WAITING_NAVIGATION' };
    }

    return { type: 'EXECUTE_STEP', step: nextStep, index: state.replayIndex, total: state.steps.length };
  },

  'STOP_REPLAY': async () => {
    if (state.activeTabId) {
      chrome.tabs.sendMessage(state.activeTabId, { type: 'REPLAY_ABORT' }).catch(() => {});
    }
    state.mode = 'idle';
    state.replayIndex = 0;
    stopKeepalive();
    await persistState();
    return { status: 'stopped' };
  },

  'STEP_FAILED': async (msg) => {
    // A step failed — switch to assisted mode
    // For Phase 0, we just pause and let the user know
    if (state.activeTabId) {
      chrome.tabs.sendMessage(state.activeTabId, {
        type: 'SHOW_ASSIST',
        step: state.steps[state.replayIndex],
        index: state.replayIndex,
        total: state.steps.length,
        reason: msg.reason,
      });
    }
    return { status: 'assisting' };
  },

  // ── State Queries ──
  'GET_STATE': async () => {
    return {
      mode: state.mode,
      workflowId: state.workflowId,
      stepCount: state.steps.length,
      replayIndex: state.replayIndex,
    };
  },

  'GET_WORKFLOWS': async () => {
    return await getAllWorkflows();
  },

  'DELETE_WORKFLOW': async (msg) => {
    await deleteWorkflow(msg.workflowId);
    return { status: 'deleted' };
  },

  'SET_BACKEND_URL': async (msg) => {
    const sanitized = sanitizeUrl(msg.backendUrl);
    if (!sanitized) {
      return { error: 'invalid backend URL' };
    }
    backendUrlCache = sanitized;
    await chrome.storage.sync.set({ backendUrl: sanitized });
    return { status: 'ok', backendUrl: sanitized };
  },

  // ── Extension Detection (for viewer page) ──
  'EXTENSION_PING': async () => {
    // Simple ping/pong for extension presence detection
    return { ok: true };
  },
};

// ── Workflow Storage (chrome.storage.local) ────────────────────────
async function saveWorkflow(workflow) {
  const result = await chrome.storage.local.get('workflows');
  const workflows = result.workflows || {};
  workflows[workflow.id] = workflow;
  await chrome.storage.local.set({ workflows });
}

async function loadWorkflow(id) {
  const result = await chrome.storage.local.get('workflows');
  return result.workflows?.[id] ?? null;
}

async function getAllWorkflows() {
  const result = await chrome.storage.local.get('workflows');
  const workflows = result.workflows || {};
  // Return as array, sorted newest first
  return Object.values(workflows).sort((a, b) => b.createdAt - a.createdAt);
}

async function deleteWorkflow(id) {
  const result = await chrome.storage.local.get('workflows');
  const workflows = result.workflows || {};
  delete workflows[id];
  await chrome.storage.local.set({ workflows });
}

async function uploadWorkflowRemote(workflow) {
  const apiBaseUrl = await getBackendBaseUrl();
  const response = await fetch(`${apiBaseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(workflow),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error('upload failed: ' + response.status + ' ' + text);
  }

  return await response.json();
}

// ── Utilities ──────────────────────────────────────────────────────
function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  for (const byte of array) {
    id += chars[byte % chars.length];
  }
  return id;
}

// ── Tab navigation listener for replay ────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (state.mode === 'replaying' && tabId === state.activeTabId && changeInfo.status === 'complete') {
    // Page finished loading during replay — content script will inject and send REPLAY_READY
  }
});
