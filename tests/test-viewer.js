const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const viewerScript = fs.readFileSync(
  path.join(__dirname, '..', 'viewer', 'viewer.js'),
  'utf8'
);

function createViewerDom(url, options = {}) {
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

  <button class="tab-btn" data-tab="upload">Upload</button>
  <button class="tab-btn" data-tab="paste">Paste</button>
  <div id="upload" class="tab-content"></div>
  <div id="paste" class="tab-content"></div>
</body>
</html>`;

  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.fetch = options.fetchImpl || (async () => ({ ok: false, status: 500 }));
  window.chrome = options.chromeMock;
  window.open = options.openMock || (() => {});

  window.eval(viewerScript);
  return { dom, window };
}

function sampleWorkflow() {
  return {
    id: 'wf_123',
    name: 'Demo Workflow',
    startUrl: 'https://example.com/start',
    createdAt: Date.now(),
    steps: [
      {
        type: 'navigate',
        url: 'https://example.com/start',
      },
    ],
  };
}

test('slug loading honors backend_url override', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ workflow: sampleWorkflow() }),
    };
  };

  createViewerDom('https://viewer.example.com/?slug=abc123&backend_url=https%3A%2F%2Fapi.example.com', {
    fetchImpl,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://api.example.com/api/links/abc123');
});

test('slug loading falls back to same-origin backend', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ workflow: sampleWorkflow() }),
    };
  };

  createViewerDom('https://viewer.example.com/?slug=same-origin-slug', {
    fetchImpl,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://viewer.example.com/api/links/same-origin-slug');
});

test('file:// slug URL shows backend-not-configured error', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return { ok: false, status: 500 };
  };

  const { window } = createViewerDom('file:///tmp/viewer.html?slug=offline', {
    fetchImpl,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetched, false);
  assert.match(window.document.getElementById('message').textContent, /Backend URL is not configured/i);
});

test('executeWorkflowInline sends replay message when extension is detected', async () => {
  const calls = [];
  const chromeMock = {
    runtime: {
      sendMessage: (msg, callback) => {
        calls.push(msg.type);

        if (typeof callback === 'function') {
          if (msg.type === 'EXTENSION_PING') {
            callback({ ok: true });
          } else {
            callback({});
          }
          return;
        }

        if (msg.type === 'START_REPLAY_INLINE') {
          return Promise.resolve({ type: 'WAITING_NAVIGATION' });
        }

        return Promise.resolve({ ok: true });
      },
    },
  };

  const { window } = createViewerDom('https://viewer.example.com/', {
    chromeMock,
  });

  window.validateAndLoadWorkflow(sampleWorkflow());
  await window.executeWorkflowInline();

  assert.deepEqual(calls, ['EXTENSION_PING', 'START_REPLAY_INLINE']);
  assert.match(window.document.getElementById('message').textContent, /Workflow started\. Navigate to start URL/i);
});

test('executeWorkflowInline shows install prompt when extension is absent', async () => {
  const { window } = createViewerDom('https://viewer.example.com/');

  window.validateAndLoadWorkflow(sampleWorkflow());
  await window.executeWorkflowInline();

  const alert = window.document.getElementById('alert');
  assert.match(alert.innerHTML, /Extension Required/i);
});
