import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadServiceWorkerCode() {
  const builtPath = path.join(__dirname, '..', 'dist', 'extension', 'background', 'service-worker.js');
  const code = fs.readFileSync(builtPath, 'utf8');

  // esbuild may emit an ESM export footer for the bundled entrypoint.
  // Strip it so we can execute in a classic VM context for tests.
  return code
    .replace(/^\s*export\s+default\s+require_service_worker\(\);?\s*$/m, 'require_service_worker();')
    .replace(/^\s*export\s+default\s+[^;]+;?\s*$/m, '');
}

const serviceWorkerCode = loadServiceWorkerCode();

const viewerCode = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'viewer', 'viewer.js'),
  'utf8'
);

function createStorageArea(target) {
  return {
    async get(key) {
      if (!key) return { ...target };
      if (key === null) return { ...target };
      if (Array.isArray(key)) {
        const out = {};
        key.forEach((k) => {
          out[k] = target[k];
        });
        return out;
      }
      if (typeof key === 'object') {
        const out = {};
        Object.keys(key).forEach((k) => {
          out[k] = target[k] === undefined ? key[k] : target[k];
        });
        return out;
      }
      return { [key]: target[key] };
    },
    async set(obj) {
      Object.assign(target, obj);
    },
    async remove(keys) {
      if (Array.isArray(keys)) {
        keys.forEach((key) => delete target[key]);
      } else {
        delete target[keys];
      }
    },
  };
}

function createServiceWorkerHarness() {
  const listeners = {
    runtimeOnMessage: null,
  };

  const storage = {
    local: {},
    session: {},
    sync: {
      backendUrl: 'https://api.trigger.test',
    },
  };

  const backendStore = {
    bySlug: new Map(),
    uploads: [],
  };

  let slugCounter = 1;

  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.runtimeOnMessage = fn;
        },
      },
    },
    tabs: {
      async create() {
        return { id: 333 };
      },
      async update() {
        return { ok: true };
      },
      async sendMessage() {
        return { ok: true };
      },
      onUpdated: {
        addListener() {},
      },
      onRemoved: {
        addListener() {},
      },
    },
    storage: {
      local: createStorageArea(storage.local),
      session: createStorageArea(storage.session),
      sync: createStorageArea(storage.sync),
    },
  };

  async function fetchImpl(url, options = {}) {
    if (url === 'https://api.trigger.test/api/workflows' && options.method === 'POST') {
      const workflow = JSON.parse(options.body);
      const slug = `slug-${slugCounter++}`;
      const shareUrl = `https://api.trigger.test/l/${slug}`;

      backendStore.uploads.push(workflow);
      backendStore.bySlug.set(slug, workflow);

      return {
        ok: true,
        async json() {
          return {
            workflowId: workflow.id,
            slug,
            shareUrl,
          };
        },
      };
    }

    if (url.startsWith('https://api.trigger.test/api/links/')) {
      const slug = decodeURIComponent(url.split('/').pop());
      const workflow = backendStore.bySlug.get(slug);
      if (!workflow) {
        return {
          ok: false,
          status: 404,
          async json() {
            return { error: 'not found' };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return {
            slug,
            workflow,
          };
        },
      };
    }

    return {
      ok: false,
      status: 500,
      async text() {
        return 'unexpected fetch';
      },
      async json() {
        return { error: 'unexpected fetch' };
      },
    };
  }

  const sandbox = {
    chrome,
    crypto: webcrypto,
    URL,
    fetch: fetchImpl,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Date,
  };

  vm.createContext(sandbox);
  vm.runInContext(serviceWorkerCode, sandbox);

  async function sendRuntimeMessage(message, sender = { tab: { id: 222, url: 'https://example.com/app' } }) {
    return await new Promise((resolve) => {
      let responded = false;
      const maybeAsync = listeners.runtimeOnMessage(message, sender, (response) => {
        responded = true;
        resolve(response);
      });

      if (maybeAsync === false && !responded) {
        resolve(undefined);
      }
    });
  }

  return {
    sendRuntimeMessage,
    backendStore,
    storage,
  };
}

function createViewerDom(url, fetchImpl, runtimeSendMessage) {
  const html = `<!doctype html>
<html>
<body>
  <div id="message"></div>
  <div id="alert"></div>
  <div id="fileUploadArea"></div>
  <input id="fileInput" type="file" />
  <textarea id="jsonInput"></textarea>
  <div id="previewContent" style="display:none"></div>
  <div id="previewEmpty" style="display:block"></div>
  <div id="workflowSummary"></div>
  <div id="stepList"></div>

  <button id="btnLoadFromUrl"></button>
  <button id="btnParseJson"></button>
  <button id="btnExecuteWorkflow" style="display:none"></button>
  <button id="btnOpenInNewTab"></button>

  <button class="tab-btn" data-tab="upload"></button>
  <button class="tab-btn" data-tab="paste"></button>
  <div id="upload" class="tab-content"></div>
  <div id="paste" class="tab-content"></div>
</body>
</html>`;

  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  dom.window.fetch = fetchImpl;
  dom.window.chrome = {
    runtime: {
      sendMessage: runtimeSendMessage,
    },
  };
  dom.window.open = () => {};

  dom.window.eval(viewerCode);
  return dom.window;
}

test('smoke: record -> share -> replay round-trip works with mocked backend and runtime', async () => {
  const harness = createServiceWorkerHarness();

  const start = await harness.sendRuntimeMessage(
    { type: 'START_RECORDING', tabId: 222 },
    { tab: { id: 222, url: 'https://example.com/app' } }
  );
  assert.equal(start.status, 'recording');

  await harness.sendRuntimeMessage(
    { type: 'RECORD_STEP', step: { type: 'navigate', url: 'https://example.com/app', title: 'App' } },
    { tab: { id: 222, url: 'https://example.com/app' } }
  );
  await harness.sendRuntimeMessage(
    { type: 'RECORD_STEP', step: { type: 'click', target: { selector: '#start-btn', text: 'Start' } } },
    { tab: { id: 222, url: 'https://example.com/app' } }
  );
  await harness.sendRuntimeMessage(
    {
      type: 'RECORD_STEP',
      step: {
        type: 'input',
        target: { name: 'email', selector: 'input[name="email"]' },
        value: 'qa@example.com',
        sensitive: false,
      },
    },
    { tab: { id: 222, url: 'https://example.com/app' } }
  );

  const stop = await harness.sendRuntimeMessage({ type: 'STOP_RECORDING' });
  assert.equal(stop.status, 'stopped');
  assert.equal(stop.workflow.steps.length, 3);
  assert.equal(harness.backendStore.uploads.length, 1);
  assert.equal(harness.backendStore.uploads[0].steps.length, 3);

  const saved = await harness.sendRuntimeMessage({ type: 'GET_WORKFLOWS' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].steps.length, 3);
  assert.match(saved[0].shareUrl, /\/l\/slug-1$/);

  let replayPayload = null;
  const viewerWindow = createViewerDom(
    'https://viewer.trigger.test/?slug=slug-1&backend_url=https%3A%2F%2Fapi.trigger.test',
    harness.backendStore.bySlug.has('slug-1')
      ? async (url) => {
          if (url.endsWith('/api/links/slug-1')) {
            return {
              ok: true,
              async json() {
                return { slug: 'slug-1', workflow: saved[0] };
              },
            };
          }
          return { ok: false, status: 500, async json() { return {}; } };
        }
      : async () => ({ ok: false, status: 404, async json() { return {}; } }),
    async (msg) => {
      if (msg.type === 'EXTENSION_PING') {
        return { ok: true };
      }
      if (msg.type === 'START_REPLAY_INLINE') {
        replayPayload = msg.workflow;
        return { type: 'WAITING_NAVIGATION' };
      }
      return { ok: true };
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  await viewerWindow.executeWorkflowInline();

  assert(replayPayload, 'Viewer should forward workflow payload to runtime replay');
  assert.equal(replayPayload.steps.length, 3);
  assert.equal(replayPayload.steps[1].type, 'click');
  assert.equal(replayPayload.steps[2].type, 'input');
});
