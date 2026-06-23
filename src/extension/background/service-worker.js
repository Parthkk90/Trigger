/**
 * Trigger - Background Service Worker
 * Coordinates recording/replay state across tabs and content scripts.
 * Implements keepalive to survive MV3 service worker termination.
 */

const _browser = typeof browser !== 'undefined' ? browser : chrome;
const SESSION_STORAGE_PREFIX = 'session_';
const HAS_NATIVE_SESSION_STORAGE = !!(
  _browser.storage &&
  _browser.storage.session &&
  typeof _browser.storage.session.get === 'function' &&
  typeof _browser.storage.session.set === 'function'
);

function toSessionFallbackKey(key) {
  return `${SESSION_STORAGE_PREFIX}${key}`;
}

async function sessionStorageGet(key) {
  if (HAS_NATIVE_SESSION_STORAGE) {
    return await _browser.storage.session.get(key);
  }
  const fallbackKey = toSessionFallbackKey(key);
  const fallback = await _browser.storage.local.get(fallbackKey);
  return { [key]: fallback[fallbackKey] };
}

async function sessionStorageSet(values) {
  if (HAS_NATIVE_SESSION_STORAGE) {
    await _browser.storage.session.set(values);
    return;
  }

  const payload = {};
  for (const [key, value] of Object.entries(values || {})) {
    payload[toSessionFallbackKey(key)] = value;
  }
  await _browser.storage.local.set(payload);
}

async function clearSessionFallbackOnStartup() {
  if (HAS_NATIVE_SESSION_STORAGE) return;

  const allLocal = await _browser.storage.local.get(null);
  const staleSessionKeys = Object.keys(allLocal || {}).filter((key) =>
    key.startsWith(SESSION_STORAGE_PREFIX)
  );
  if (staleSessionKeys.length > 0) {
    await _browser.storage.local.remove(staleSessionKeys);
  }
}

// ── State ──────────────────────────────────────────────────────────
let state = {
  mode: 'idle',        // 'idle' | 'recording' | 'replaying'
  activeTabId: null,
  workflowId: null,
  steps: [],
  replayIndex: 0,
  credentialPrompts: [],
  sensitiveStepKeys: {},
  credentialsReady: true,
  replaySessionStatus: 'idle', // 'idle' | 'active' | 'awaiting_user' | 'recovering' | 'failed' | 'completed' | 'aborted'
  stepRetries: {},
  maxStepRetries: 3,
  lastReplayHeartbeatAt: 0,
  lastReplayProgressAt: 0,
  recoveryAttempts: 0,
};

let backendUrlCache = null;
const KEEPALIVE_INTERVAL_MS = 20000;
const REPLAY_HEARTBEAT_STALE_MS = 45000;
const MAX_RECOVERY_ATTEMPTS = 3;
const REPLAY_FRESHNESS_THRESHOLD = 60;
const UPLOAD_QUEUE_KEY = 'uploadRetryQueue';
const UPLOAD_MAX_RETRIES = 5;
const UPLOAD_INITIAL_BACKOFF_MS = 2000;

let uploadRetryTimer = null;

let replayFreshnessCheck = {
  pending: false,
  sampleSteps: [],
};

// ── MV3 Keepalive ──────────────────────────────────────────────────
// Service workers die after ~30s of inactivity in MV3.
// During active recording/replay, we ping to stay alive.
let keepaliveInterval = null;

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    // Any extension storage API call resets the termination timer.
    sessionStorageGet('keepalive');

    if (state.mode === 'replaying') {
      maybeRecoverReplay().catch((err) => {
        console.warn('[Trigger] Replay recovery tick failed:', err.message);
      });
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

function computeUploadBackoffMs(attempt) {
  return UPLOAD_INITIAL_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
}

async function getUploadRetryQueue() {
  const result = await _browser.storage.local.get(UPLOAD_QUEUE_KEY);
  return Array.isArray(result[UPLOAD_QUEUE_KEY]) ? result[UPLOAD_QUEUE_KEY] : [];
}

async function setUploadRetryQueue(queue) {
  await _browser.storage.local.set({ [UPLOAD_QUEUE_KEY]: queue });
}

async function enqueueUploadRetry(workflow, reason) {
  const queue = await getUploadRetryQueue();
  const existingIndex = queue.findIndex((entry) => entry.workflow && entry.workflow.id === workflow.id);
  const now = Date.now();
  const base = {
    workflow,
    attempts: 0,
    nextAttemptAt: now,
    lastError: reason || 'upload_failed',
    enqueuedAt: now,
  };

  if (existingIndex >= 0) {
    queue[existingIndex] = {
      ...queue[existingIndex],
      workflow,
      lastError: reason || queue[existingIndex].lastError,
    };
  } else {
    queue.push(base);
  }

  await setUploadRetryQueue(queue);
  scheduleUploadRetryWorker();
}

function scheduleUploadRetryWorker(delayMs = 0) {
  if (uploadRetryTimer) {
    clearTimeout(uploadRetryTimer);
    uploadRetryTimer = null;
  }

  uploadRetryTimer = setTimeout(() => {
    processUploadRetryQueue().catch((err) => {
      console.warn('[Trigger] Upload retry worker failed:', err.message);
      scheduleUploadRetryWorker(UPLOAD_INITIAL_BACKOFF_MS);
    });
  }, Math.max(0, delayMs));
}

async function processUploadRetryQueue() {
  const queue = await getUploadRetryQueue();
  if (queue.length === 0) {
    if (uploadRetryTimer) {
      clearTimeout(uploadRetryTimer);
      uploadRetryTimer = null;
    }
    return;
  }

  const now = Date.now();
  let nextWakeDelay = null;
  const updatedQueue = [];

  for (const entry of queue) {
    if (!entry || !entry.workflow) continue;

    const attempts = Number(entry.attempts || 0);
    const nextAttemptAt = Number(entry.nextAttemptAt || now);

    if (nextAttemptAt > now) {
      updatedQueue.push(entry);
      const wait = nextAttemptAt - now;
      nextWakeDelay = nextWakeDelay === null ? wait : Math.min(nextWakeDelay, wait);
      continue;
    }

    try {
      await uploadWorkflowRemote(entry.workflow);
      console.log('[Trigger] Upload retry succeeded for workflow', entry.workflow.id);
    } catch (err) {
      const nextAttempt = attempts + 1;
      if (nextAttempt >= UPLOAD_MAX_RETRIES) {
        console.warn(
          '[Trigger] Upload retry exhausted for workflow',
          entry.workflow.id,
          '- last error:',
          err.message
        );
        continue;
      }

      const backoff = computeUploadBackoffMs(nextAttempt);
      const retriable = {
        ...entry,
        attempts: nextAttempt,
        nextAttemptAt: now + backoff,
        lastError: err.message,
      };
      updatedQueue.push(retriable);
      nextWakeDelay = nextWakeDelay === null ? backoff : Math.min(nextWakeDelay, backoff);
    }
  }

  await setUploadRetryQueue(updatedQueue);

  if (updatedQueue.length > 0) {
    scheduleUploadRetryWorker(nextWakeDelay === null ? UPLOAD_INITIAL_BACKOFF_MS : nextWakeDelay);
  } else if (uploadRetryTimer) {
    clearTimeout(uploadRetryTimer);
    uploadRetryTimer = null;
  }
}

// ── Persist state to survive service worker restart ────────────────
async function persistState() {
  await sessionStorageSet({ triggerState: state });
}

async function restoreState() {
  const result = await sessionStorageGet('triggerState');
  if (result.triggerState) {
    state = {
      ...state,
      ...result.triggerState,
      credentialPrompts: result.triggerState.credentialPrompts || [],
      sensitiveStepKeys: result.triggerState.sensitiveStepKeys || {},
      credentialsReady: result.triggerState.credentialsReady !== false,
      stepRetries: result.triggerState.stepRetries || {},
      maxStepRetries: result.triggerState.maxStepRetries || 3,
      lastReplayHeartbeatAt: result.triggerState.lastReplayHeartbeatAt || 0,
      lastReplayProgressAt: result.triggerState.lastReplayProgressAt || 0,
      recoveryAttempts: result.triggerState.recoveryAttempts || 0,
    };
    if (state.mode !== 'idle') {
      startKeepalive();
    }
  }
}

// Reads backend URL from sync storage.
async function getBackendBaseUrl() {
  if (backendUrlCache) {
    return backendUrlCache;
  }
  const result = await _browser.storage.sync.get('backendUrl');
  const configured = await getBackendUrl('extension');
  backendUrlCache = configured || null;
  return backendUrlCache;
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

function buildReplayFreshnessSample(steps) {
  const sample = [];
  for (let i = 0; i < steps.length && sample.length < 3; i += 1) {
    const step = steps[i];
    if (!step || !step.target) continue;
    sample.push({ ...step, index: typeof step.index === 'number' ? step.index : i });
  }
  return sample;
}

function classifyFailure(reason, reasonType) {
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

function isRetryableFailure(reasonType) {
  return reasonType === 'selector_not_found' || reasonType === 'navigation_timeout' || reasonType === 'unknown_error';
}

async function logReplayFailure(entry) {
  const result = await _browser.storage.local.get('replayDebugLogs');
  const logs = Array.isArray(result.replayDebugLogs) ? result.replayDebugLogs : [];
  logs.push(entry);
  const capped = logs.slice(-200);
  await _browser.storage.local.set({ replayDebugLogs: capped });
}

async function maybeRecoverReplay() {
  if (state.mode !== 'replaying' || !state.activeTabId) return;

  const now = Date.now();
  const staleSince = Math.max(state.lastReplayHeartbeatAt || 0, state.lastReplayProgressAt || 0);
  if (!staleSince || now - staleSince < REPLAY_HEARTBEAT_STALE_MS) return;
  if (state.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    await abortReplaySession('watchdog_retry_exhausted', 'Max recovery attempts reached');
    return;
  }

  state.recoveryAttempts += 1;
  state.lastReplayHeartbeatAt = now;
  await persistState();

  try {
    await _browser.tabs.sendMessage(state.activeTabId, { type: 'PING' });
  } catch (err) {
    console.warn('[Trigger] Replay tab not ready for recovery ping:', err.message);
    await logReplayFailure({
      ts: Date.now(),
      workflowId: state.workflowId,
      index: state.replayIndex,
      reason: err.message,
      reasonType: 'recovery_ping_failed',
      retries: state.recoveryAttempts,
      maxRetries: MAX_RECOVERY_ATTEMPTS,
      canRetry: state.recoveryAttempts < MAX_RECOVERY_ATTEMPTS,
      sessionStatus: state.replaySessionStatus,
    });
    return;
  }

  try {
    state.replaySessionStatus = 'recovering';
    await persistState();
    await _browser.tabs.sendMessage(state.activeTabId, { type: 'EXECUTE_STEP_RECOVERY' });
    console.log('[Trigger] Requested replay recovery attempt', state.recoveryAttempts);
  } catch (err) {
    console.warn('[Trigger] Failed to send replay recovery request:', err.message);
    await logReplayFailure({
      ts: Date.now(),
      workflowId: state.workflowId,
      index: state.replayIndex,
      reason: err.message,
      reasonType: 'recovery_request_failed',
      retries: state.recoveryAttempts,
      maxRetries: MAX_RECOVERY_ATTEMPTS,
      canRetry: state.recoveryAttempts < MAX_RECOVERY_ATTEMPTS,
      sessionStatus: state.replaySessionStatus,
    });
  }
}

async function abortReplaySession(reasonType, reason) {
  await logReplayFailure({
    ts: Date.now(),
    workflowId: state.workflowId,
    index: state.replayIndex,
    reason: reason || 'Replay aborted',
    reasonType: reasonType || 'unknown_error',
    retries: state.recoveryAttempts || 0,
    maxRetries: MAX_RECOVERY_ATTEMPTS,
    canRetry: false,
    sessionStatus: 'failed',
  });

  state.mode = 'idle';
  state.replaySessionStatus = 'failed';
  state.lastReplayHeartbeatAt = 0;
  state.lastReplayProgressAt = 0;
  state.activeTabId = null;
  state.credentialPrompts = [];
  state.sensitiveStepKeys = {};
  state.credentialsReady = true;
  replayFreshnessCheck.pending = false;
  replayFreshnessCheck.sampleSteps = [];
  stopKeepalive();
  await persistState();
}

function normalizeCredentialKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function deriveCredentialLabel(step, index) {
  const target = step && step.target ? step.target : {};
  return target.ariaLabel || target.placeholder || target.name || target.text || `Sensitive field ${index + 1}`;
}

function deriveCredentialKey(step, index) {
  const target = step && step.target ? step.target : {};
  const base = target.name || target.ariaLabel || target.placeholder || target.text || `field_${index}`;
  const key = normalizeCredentialKey(base);
  return key || `field_${index}`;
}

function buildCredentialMetadata(steps) {
  const promptsByKey = {};
  const sensitiveStepKeys = {};

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] || {};
    if (step.type !== 'input' || !step.sensitive) continue;

    const stepIndex = typeof step.index === 'number' ? step.index : i;
    const key = deriveCredentialKey(step, stepIndex);
    const label = deriveCredentialLabel(step, stepIndex);
    sensitiveStepKeys[stepIndex] = key;

    if (!promptsByKey[key]) {
      promptsByKey[key] = {
        key,
        label,
        stepIndices: [stepIndex],
      };
    } else {
      promptsByKey[key].stepIndices.push(stepIndex);
    }
  }

  return {
    prompts: Object.values(promptsByKey),
    sensitiveStepKeys,
  };
}

function getStepStableIndex(step, fallbackIndex) {
  if (step && typeof step.index === 'number') return step.index;
  return fallbackIndex;
}

function prepareStepForExecution(step, index) {
  if (!step) return step;
  const stepIndex = getStepStableIndex(step, index);
  const credentialKey = state.sensitiveStepKeys[stepIndex];
  if (!credentialKey) return step;
  return {
    ...step,
    _credentialKey: credentialKey,
  };
}

function getReplayResponseForCurrentIndex() {
  const step = state.steps[state.replayIndex];
  if (!step) {
    return { type: 'REPLAY_COMPLETE' };
  }

  return {
    type: 'EXECUTE_STEP',
    step: prepareStepForExecution(step, state.replayIndex),
    index: state.replayIndex,
    total: state.steps.length,
  };
}

async function getReplayResponseForCompletedIndex(index) {
  state.replayIndex = index + 1;
  state.lastReplayProgressAt = Date.now();
  state.lastReplayHeartbeatAt = Date.now();
  state.recoveryAttempts = 0;
  state.replaySessionStatus = 'active';
  delete state.stepRetries[index];
  await persistState();

  if (state.replayIndex >= state.steps.length) {
    state.mode = 'idle';
    state.replaySessionStatus = 'completed';
    stopKeepalive();
    await persistState();
    return { type: 'REPLAY_COMPLETE' };
  }

  const nextStep = state.steps[state.replayIndex];
  if (nextStep.type === 'navigate') {
    await _browser.tabs.update(state.activeTabId, { url: nextStep.url });
    return { type: 'WAITING_NAVIGATION' };
  }

  return {
    type: 'EXECUTE_STEP',
    step: prepareStepForExecution(nextStep, state.replayIndex),
    index: state.replayIndex,
    total: state.steps.length,
  };
}

// Restore persistent state and retry worker on startup.
async function initializeBackgroundState() {
  await clearSessionFallbackOnStartup();
  await restoreState();
  await processUploadRetryQueue();
}

initializeBackgroundState().catch((err) => {
  console.warn('[Trigger] Failed to initialize background state:', err.message);
});

// ── Message Router ─────────────────────────────────────────────────
_browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    state.replaySessionStatus = 'idle';
    startKeepalive();
    await persistState();

    // Notify content script to activate recorder
    try {
      await _browser.tabs.sendMessage(state.activeTabId, {
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
      await enqueueUploadRetry(workflow, err.message);
    }

    // Save tab ID before clearing state
    const tabId = state.activeTabId;

    state.mode = 'idle';
    state.activeTabId = null;
    state.replaySessionStatus = 'idle';
    stopKeepalive();
    await persistState();

    // Notify content script to deactivate recorder
    if (tabId) {
      _browser.tabs.sendMessage(tabId, {
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
    const credentialMetadata = buildCredentialMetadata(workflow.steps);
    state.credentialPrompts = credentialMetadata.prompts;
    state.sensitiveStepKeys = credentialMetadata.sensitiveStepKeys;
    state.credentialsReady = state.credentialPrompts.length === 0;
    replayFreshnessCheck.sampleSteps = buildReplayFreshnessSample(workflow.steps);
    replayFreshnessCheck.pending = replayFreshnessCheck.sampleSteps.length > 0;
    state.replaySessionStatus = 'active';
    state.stepRetries = {};
    state.lastReplayHeartbeatAt = Date.now();
    state.lastReplayProgressAt = Date.now();
    state.recoveryAttempts = 0;
    startKeepalive();
    await persistState();

    // Open starting URL in a new tab
    const tab = await _browser.tabs.create({ url: workflow.startUrl });
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
    const credentialMetadata = buildCredentialMetadata(workflow.steps);
    state.credentialPrompts = credentialMetadata.prompts;
    state.sensitiveStepKeys = credentialMetadata.sensitiveStepKeys;
    state.credentialsReady = state.credentialPrompts.length === 0;
    replayFreshnessCheck.sampleSteps = buildReplayFreshnessSample(workflow.steps);
    replayFreshnessCheck.pending = replayFreshnessCheck.sampleSteps.length > 0;
    state.replaySessionStatus = 'active';
    state.stepRetries = {};
    state.activeTabId = sender.tab.id;
    state.lastReplayHeartbeatAt = Date.now();
    state.lastReplayProgressAt = Date.now();
    state.recoveryAttempts = 0;
    startKeepalive();
    await persistState();

    if (workflow.startUrl && sender.tab.url !== workflow.startUrl) {
      await _browser.tabs.update(sender.tab.id, { url: workflow.startUrl });
      return { type: 'WAITING_NAVIGATION' };
    }

    if (!state.credentialsReady) {
      return {
        type: 'REQUEST_CREDENTIALS',
        prompts: state.credentialPrompts,
      };
    }

    const firstStep = state.steps[0];
    if (!firstStep) return { type: 'REPLAY_COMPLETE' };
    return {
      type: 'EXECUTE_STEP',
      step: prepareStepForExecution(firstStep, 0),
      index: 0,
      total: state.steps.length,
    };
  },

  'REPLAY_READY': async (msg, sender) => {
    // Content script reports it's loaded and ready for next step
    if (state.mode !== 'replaying') return { error: 'not replaying' };
    if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

    state.lastReplayHeartbeatAt = Date.now();
    state.recoveryAttempts = 0;
    state.replaySessionStatus = 'active';
    await persistState();

    if (!state.credentialsReady && state.credentialPrompts.length > 0) {
      state.replaySessionStatus = 'awaiting_user';
      await persistState();
      return {
        type: 'REQUEST_CREDENTIALS',
        prompts: state.credentialPrompts,
      };
    }

    if (replayFreshnessCheck.pending) {
      state.replaySessionStatus = 'awaiting_user';
      await persistState();
      return {
        type: 'CHECK_DOM_DRIFT',
        sampleSteps: replayFreshnessCheck.sampleSteps,
        threshold: REPLAY_FRESHNESS_THRESHOLD,
      };
    }

    return getReplayResponseForCurrentIndex();
  },

  'DOM_DRIFT_DECISION': async (msg, sender) => {
    if (state.mode !== 'replaying') return { error: 'not replaying' };
    if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

    replayFreshnessCheck.pending = false;

    if (!msg || msg.proceed !== true) {
      if (state.activeTabId) {
        _browser.tabs.sendMessage(state.activeTabId, { type: 'REPLAY_ABORT' }).catch(() => {});
      }
      state.mode = 'idle';
      state.replaySessionStatus = 'aborted';
      state.replayIndex = 0;
      state.lastReplayHeartbeatAt = 0;
      state.lastReplayProgressAt = 0;
      stopKeepalive();
      await persistState();
      return { status: 'aborted' };
    }

    state.replaySessionStatus = 'active';
    await persistState();
    return getReplayResponseForCurrentIndex();
  },

  'SUBMIT_REPLAY_CREDENTIALS': async (msg, sender) => {
    if (state.mode !== 'replaying') return { error: 'not replaying' };
    if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

    state.credentialsReady = true;
    state.replaySessionStatus = 'active';
    state.lastReplayHeartbeatAt = Date.now();
    await persistState();

    return getReplayResponseForCurrentIndex();
  },

  'STEP_COMPLETED': async (msg) => {
    if (state.mode !== 'replaying') return { error: 'not replaying' };
    return await getReplayResponseForCompletedIndex(msg.index);
  },

  'STOP_REPLAY': async () => {
    if (state.activeTabId) {
      _browser.tabs.sendMessage(state.activeTabId, { type: 'REPLAY_ABORT' }).catch(() => {});
    }
    state.mode = 'idle';
    state.replaySessionStatus = 'aborted';
    state.replayIndex = 0;
    state.lastReplayHeartbeatAt = 0;
    state.lastReplayProgressAt = 0;
    stopKeepalive();
    await persistState();
    return { status: 'stopped' };
  },

  'STEP_FAILED': async (msg) => {
    if (state.mode !== 'replaying') return { error: 'not replaying' };

    const index = typeof msg.index === 'number' ? msg.index : state.replayIndex;
    const reasonType = classifyFailure(msg.reason, msg.reasonType);
    const retries = state.stepRetries[index] || 0;
    const maxRetries = state.maxStepRetries || 3;
    const canRetry = isRetryableFailure(reasonType) && retries < maxRetries;

    await logReplayFailure({
      ts: Date.now(),
      workflowId: state.workflowId,
      index,
      reason: msg.reason || 'unknown',
      reasonType,
      confidence: msg.confidence ?? null,
      retries,
      maxRetries,
      canRetry,
    });

    if (canRetry) {
      state.stepRetries[index] = retries + 1;
      state.lastReplayHeartbeatAt = Date.now();
      state.replaySessionStatus = 'active';
      await persistState();

      const step = state.steps[index];
      return {
        type: 'EXECUTE_STEP',
        step,
        index,
        total: state.steps.length,
        retry: {
          attempt: state.stepRetries[index],
          maxRetries,
          reasonType,
        },
      };
    }

    // Retries exhausted or non-retryable - switch to assist mode.
    state.replaySessionStatus = 'awaiting_user';
    await persistState();

    if (state.activeTabId) {
      _browser.tabs.sendMessage(state.activeTabId, {
        type: 'SHOW_ASSIST',
        step: state.steps[state.replayIndex],
        index,
        total: state.steps.length,
        reason: `[${reasonType}] ${msg.reason || 'Step failed'}`,
        reasonType,
        retries,
        maxRetries,
      });
    }
    return { status: 'assisting', reasonType, retries, maxRetries };
  },

  'ASSIST_ACTION': async (msg, sender) => {
    if (state.mode !== 'replaying') return { error: 'not replaying' };
    if (sender.tab?.id && sender.tab.id !== state.activeTabId) return { error: 'wrong tab' };

    const index = typeof msg.index === 'number' ? msg.index : state.replayIndex;
    const action = msg.action;

    if (action === 'retry') {
      const step = state.steps[index];
      state.replaySessionStatus = 'active';
      state.lastReplayHeartbeatAt = Date.now();
      await persistState();

      if (state.activeTabId) {
        await _browser.tabs.sendMessage(state.activeTabId, {
          type: 'EXECUTE_STEP',
          step: prepareStepForExecution(step, index),
          index,
          total: state.steps.length,
        });
      }
      return { status: 'retrying', index };
    }

    if (action === 'skip' || action === 'mark_fixed') {
      const response = await getReplayResponseForCompletedIndex(index);
      if (state.activeTabId) {
        await _browser.tabs.sendMessage(state.activeTabId, response);
      }
      return { status: action === 'skip' ? 'skipped' : 'marked_fixed', index, responseType: response.type };
    }

    return { error: 'unknown assist action' };
  },

  'REPLAY_HEARTBEAT': async (msg, sender) => {
    if (state.mode !== 'replaying') return { ok: false, reason: 'not replaying' };
    if (sender.tab?.id !== state.activeTabId) return { ok: false, reason: 'wrong tab' };
    state.lastReplayHeartbeatAt = Date.now();
    state.replaySessionStatus = 'active';
    state.recoveryAttempts = 0;
    await persistState();
    return { ok: true, index: state.replayIndex };
  },

  // ── State Queries ──
  'GET_STATE': async () => {
    return {
      mode: state.mode,
      sessionStatus: state.replaySessionStatus,
      workflowId: state.workflowId,
      stepCount: state.steps.length,
      replayIndex: state.replayIndex,
      credentialPromptCount: state.credentialPrompts.length,
      credentialsReady: state.credentialsReady,
      recoveryAttempts: state.recoveryAttempts,
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
    await _browser.storage.sync.set({ backendUrl: sanitized });
    return { status: 'ok', backendUrl: sanitized };
  },

  // ── Extension Detection (for viewer page) ──
  'EXTENSION_PING': async () => {
    // Simple ping/pong for extension presence detection
    return { ok: true };
  },
};

// ── Workflow Storage (_browser.storage.local) ────────────────────────
async function saveWorkflow(workflow) {
  const result = await _browser.storage.local.get('workflows');
  const workflows = result.workflows || {};
  workflows[workflow.id] = workflow;
  await _browser.storage.local.set({ workflows });
}

async function loadWorkflow(id) {
  const result = await _browser.storage.local.get('workflows');
  return result.workflows?.[id] ?? null;
}

async function getAllWorkflows() {
  const result = await _browser.storage.local.get('workflows');
  const workflows = result.workflows || {};
  // Return as array, sorted newest first
  return Object.values(workflows).sort((a, b) => b.createdAt - a.createdAt);
}

async function deleteWorkflow(id) {
  const result = await _browser.storage.local.get('workflows');
  const workflows = result.workflows || {};
  delete workflows[id];
  await _browser.storage.local.set({ workflows });
}

async function uploadWorkflowRemote(workflow) {
  const apiBaseUrl = await getBackendBaseUrl();
  if (!apiBaseUrl) {
    throw new Error('backend URL not configured');
  }

  const { apiToken } = await _browser.storage.sync.get('apiToken');
  const headers = {
    'Content-Type': 'application/json',
  };

  if (apiToken) {
    headers['Authorization'] = `Bearer ${apiToken}`;
  }

  const response = await fetch(`${apiBaseUrl}/api/workflows`, {
    method: 'POST',
    headers,
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
_browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (state.mode === 'replaying' && tabId === state.activeTabId && changeInfo.status === 'complete') {
    // Page finished loading during replay - content script will inject and send REPLAY_READY
  }
});

_browser.tabs.onRemoved.addListener((tabId) => {
  if (state.mode === 'replaying' && tabId === state.activeTabId) {
    abortReplaySession('tab_closed', 'Replay tab was closed during active session').catch((err) => {
      console.warn('[Trigger] Failed to abort replay after tab removal:', err.message);
    });
  }
});
});

_browser.tabs.onRemoved.addListener((tabId) => {
  if (state.mode === 'replaying' && tabId === state.activeTabId) {
    abortReplaySession('tab_closed', 'Replay tab was closed during active session').catch((err) => {
      console.warn('[Trigger] Failed to abort replay after tab removal:', err.message);
    });
  }
});
