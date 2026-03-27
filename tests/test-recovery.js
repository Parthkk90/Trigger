const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const swCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'service-worker.js'),
  'utf8'
);

function createStorageArea(target) {
  return {
    async get(key) {
      if (!key) return { ...target };
      if (Array.isArray(key)) {
        const out = {};
        key.forEach((k) => { out[k] = target[k]; });
        return out;
      }
      if (typeof key === 'string') return { [key]: target[key] };
      if (typeof key === 'object') {
        const out = {};
        Object.keys(key).forEach((k) => {
          out[k] = target[k] === undefined ? key[k] : target[k];
        });
        return out;
      }
      return { ...target };
    },
    async set(obj) {
      Object.assign(target, obj);
    },
    async remove(key) {
      if (Array.isArray(key)) {
        key.forEach((k) => delete target[k]);
      } else {
        delete target[key];
      }
    },
  };
}

function createHarness(options = {}) {
  const listeners = {
    onRuntimeMessage: null,
    onTabsUpdated: null,
    onTabsRemoved: null,
  };

  const storage = {
    local: options.local || {},
    session: options.session || {},
    sync: options.sync || {},
  };

  const messages = [];
  let now = options.now || 1_700_000_000_000;
  let createdTabId = options.createdTabId || 321;
  const intervals = new Map();
  let intervalId = 1;

  const tabsSendMessageImpl = options.tabsSendMessage || (async () => ({ ok: true }));

  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.onRuntimeMessage = fn;
        },
      },
    },
    tabs: {
      async create() {
        return { id: createdTabId };
      },
      async update() {
        return { ok: true };
      },
      async sendMessage(tabId, message) {
        messages.push({ tabId, message });
        return tabsSendMessageImpl(tabId, message);
      },
      onUpdated: {
        addListener(fn) {
          listeners.onTabsUpdated = fn;
        },
      },
      onRemoved: {
        addListener(fn) {
          listeners.onTabsRemoved = fn;
        },
      },
    },
    storage: {
      local: createStorageArea(storage.local),
      session: createStorageArea(storage.session),
      sync: createStorageArea(storage.sync),
    },
  };

  const sandbox = {
    chrome,
    crypto: webcrypto,
    URL,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console,
    Date: {
      now: () => now,
    },
    setInterval: (cb, ms) => {
      const id = intervalId++;
      intervals.set(id, { cb, ms });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(swCode, sandbox);

  async function sendRuntimeMessage(message, sender = { tab: { id: createdTabId, url: 'https://example.com' } }) {
    return await new Promise((resolve) => {
      let settled = false;
      const maybeAsync = listeners.onRuntimeMessage(message, sender, (response) => {
        settled = true;
        resolve(response);
      });

      if (maybeAsync === false && !settled) {
        settled = true;
        resolve(undefined);
      }
    });
  }

  async function flush() {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

  async function tickKeepalive() {
    for (const item of intervals.values()) {
      if (item.ms === 20000) {
        await item.cb();
      }
    }
    await flush();
  }

  return {
    storage,
    listeners,
    messages,
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    createdTabId,
    sendRuntimeMessage,
    tickKeepalive,
    flush,
  };
}

async function getSessionState(harness) {
  return await harness.sendRuntimeMessage({ type: 'GET_STATE' }, { tab: { id: harness.createdTabId } });
}

async function waitForSession(harness, predicate) {
  for (let i = 0; i < 20; i++) {
    const state = await getSessionState(harness);
    if (predicate(state)) return state;
    await harness.flush();
  }
  return await getSessionState(harness);
}

function createWorkflow(id = 'wf-recovery') {
  return {
    id,
    name: 'Recovery Workflow',
    startUrl: 'https://example.com/start',
    createdAt: Date.now(),
    steps: [
      { type: 'click', target: { selector: '#a' } },
      { type: 'click', target: { selector: '#b' } },
    ],
  };
}

function assertFailureLogShape(entry) {
  assert.equal(typeof entry.ts, 'number');
  assert.equal(typeof entry.workflowId, 'string');
  assert.equal(typeof entry.reason, 'string');
  assert.equal(typeof entry.reasonType, 'string');
  assert.equal(typeof entry.retries, 'number');
  assert.equal(typeof entry.maxRetries, 'number');
  assert.equal(typeof entry.canRetry, 'boolean');
  assert.equal(typeof entry.sessionStatus, 'string');
}

test('tab crash mid-replay triggers failed session and structured log', async () => {
  const harness = createHarness();
  const workflow = createWorkflow();
  harness.storage.local.workflows = { [workflow.id]: workflow };

  await harness.sendRuntimeMessage({ type: 'START_REPLAY', workflowId: workflow.id }, { tab: { id: 10, url: workflow.startUrl } });

  assert(harness.listeners.onTabsRemoved, 'tabs.onRemoved listener should be registered');
  harness.listeners.onTabsRemoved(harness.createdTabId);
  await harness.flush();

  const state = await waitForSession(harness, (s) => s && s.mode === 'idle');
  assert.equal(state.mode, 'idle');
  assert.equal(state.sessionStatus, 'failed');
  assert.equal(harness.storage.session.triggerState.lastReplayHeartbeatAt, 0);

  const logs = harness.storage.local.replayDebugLogs;
  assert(Array.isArray(logs) && logs.length > 0);
  const last = logs[logs.length - 1];
  assertFailureLogShape(last);
  assert.equal(last.reasonType, 'tab_closed');
  assert.equal(state.recoveryAttempts, 0);
});

test('stale session recovery retries to ceiling then aborts', async () => {
  const harness = createHarness({
    tabsSendMessage: async () => {
      throw new Error('tab unreachable');
    },
  });
  const workflow = createWorkflow('wf-stale');
  harness.storage.local.workflows = { [workflow.id]: workflow };

  await harness.sendRuntimeMessage({ type: 'START_REPLAY', workflowId: workflow.id }, { tab: { id: 11, url: workflow.startUrl } });

  harness.now += 50000;
  await harness.tickKeepalive();
  harness.now += 50000;
  await harness.tickKeepalive();
  harness.now += 50000;
  await harness.tickKeepalive();
  harness.now += 50000;
  await harness.tickKeepalive();

  const state = await waitForSession(harness, (s) => s && s.mode === 'idle');
  assert.equal(state.mode, 'idle');
  assert.equal(state.sessionStatus, 'failed');
  assert.equal(state.recoveryAttempts, 3);

  const logs = harness.storage.local.replayDebugLogs;
  assert(Array.isArray(logs) && logs.length > 0);
  const last = logs[logs.length - 1];
  assertFailureLogShape(last);
  assert.equal(last.reasonType, 'watchdog_retry_exhausted');
});

test('prolonged idle triggers watchdog recovery attempt', async () => {
  const harness = createHarness({
    tabsSendMessage: async (_tabId, message) => {
      if (message.type === 'EXECUTE_STEP_RECOVERY') {
        throw new Error('recovery request failed once');
      }
      return { ok: true };
    },
  });
  const workflow = createWorkflow('wf-idle');
  harness.storage.local.workflows = { [workflow.id]: workflow };

  await harness.sendRuntimeMessage({ type: 'START_REPLAY', workflowId: workflow.id }, { tab: { id: 12, url: workflow.startUrl } });

  harness.now += 50000;
  await harness.tickKeepalive();

  const state = await waitForSession(harness, (s) => s && s.recoveryAttempts === 1);
  assert.equal(state.recoveryAttempts, 1);

  const recoveryMessage = harness.messages.find((m) => m.message.type === 'EXECUTE_STEP_RECOVERY');
  assert(recoveryMessage, 'expected recovery message to be attempted');

  for (let i = 0; i < 10; i++) {
    const logs = harness.storage.local.replayDebugLogs || [];
    if (Array.isArray(logs) && logs.length > 0) break;
    await harness.flush();
  }

  const logs = harness.storage.local.replayDebugLogs || [];
  assert(Array.isArray(logs) && logs.length > 0);
  const last = logs[logs.length - 1];
  assertFailureLogShape(last);
  assert.equal(last.reasonType, 'recovery_request_failed');
});

test('successful recovery on second try resumes from last confirmed step', async () => {
  let recoverySends = 0;
  const harness = createHarness({
    tabsSendMessage: async (_tabId, message) => {
      if (message.type === 'EXECUTE_STEP_RECOVERY') {
        recoverySends += 1;
        if (recoverySends === 1) {
          throw new Error('first recovery attempt failed');
        }
      }
      return { ok: true };
    },
  });

  const workflow = createWorkflow('wf-resume');
  harness.storage.local.workflows = { [workflow.id]: workflow };

  await harness.sendRuntimeMessage({ type: 'START_REPLAY', workflowId: workflow.id }, { tab: { id: 13, url: workflow.startUrl } });
  await harness.sendRuntimeMessage({ type: 'STEP_COMPLETED', index: 0 }, { tab: { id: harness.createdTabId } });

  harness.now += 50000;
  await harness.tickKeepalive();
  harness.now += 50000;
  await harness.tickKeepalive();

  await harness.sendRuntimeMessage({ type: 'REPLAY_HEARTBEAT' }, { tab: { id: harness.createdTabId } });

  const state = await waitForSession(harness, (s) => s && s.sessionStatus === 'active' && s.recoveryAttempts === 0);
  assert.equal(state.replayIndex, 1);
  assert.equal(state.sessionStatus, 'active');
  assert.equal(state.recoveryAttempts, 0);

  const logs = harness.storage.local.replayDebugLogs || [];
  assert(Array.isArray(logs));
  const failedRecovery = logs.find((entry) => entry.reasonType === 'recovery_request_failed');
  assert(failedRecovery, 'expected failed recovery log entry from first attempt');
  assertFailureLogShape(failedRecovery);
});
