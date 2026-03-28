/**
 * Trigger — Popup Script
 * Controls the extension popup UI: start/stop recording, manage workflows.
 */

const btnRecord = document.getElementById('btn-record');
const controls = document.getElementById('controls');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const notice = document.getElementById('notice');
const workflowList = document.getElementById('workflow-list');
const btnSettings = document.getElementById('btn-settings');

let currentState = null;

// ── Initialize ─────────────────────────────────────────────────────

async function init() {
  currentState = await sendMessage({ type: 'GET_STATE' });
  renderControls();

  // Set up event delegation once
  workflowList.addEventListener('click', handleWorkflowAction);
  btnSettings.addEventListener('click', configureShareSettings);

  await loadWorkflows();
}

// ── Controls ───────────────────────────────────────────────────────

function renderControls() {
  const mode = currentState?.mode || 'idle';

  statusDot.className = `status-dot ${mode}`;

  if (mode === 'idle') {
    statusText.textContent = 'Ready';
    controls.innerHTML = `
      <button class="btn btn-record" id="btn-record">
        <span>●</span> Record
      </button>
    `;
    document.getElementById('btn-record').addEventListener('click', startRecording);

  } else if (mode === 'recording') {
    statusText.textContent = `Recording (${currentState.stepCount || 0} steps)`;
    controls.innerHTML = `
      <button class="btn btn-record active" id="btn-recording" disabled>
        <span>●</span> Recording...
      </button>
      <button class="btn btn-stop" id="btn-stop">■ Stop</button>
    `;
    document.getElementById('btn-stop').addEventListener('click', stopRecording);

  } else if (mode === 'replaying') {
    statusText.textContent = `Replaying step ${currentState.replayIndex + 1}`;
    controls.innerHTML = `
      <button class="btn btn-stop" id="btn-stop">■ Stop Replay</button>
    `;
    document.getElementById('btn-stop').addEventListener('click', stopReplay);
  }
}

async function startRecording() {
  // Get the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  currentState = await sendMessage({ type: 'START_RECORDING', tabId: tab.id });
  currentState.mode = 'recording';
  currentState.stepCount = 0;
  renderControls();

  // Close popup so user can interact with the page
  window.close();
}

async function stopRecording() {
  const result = await sendMessage({ type: 'STOP_RECORDING' });
  currentState = { mode: 'idle' };
  renderControls();
  await loadWorkflows();
}

async function stopReplay() {
  await sendMessage({ type: 'STOP_REPLAY' });
  currentState = { mode: 'idle' };
  renderControls();
}

// ── Workflows ──────────────────────────────────────────────────────

async function loadWorkflows() {
  const workflows = await sendMessage({ type: 'GET_WORKFLOWS' });

  if (!workflows || workflows.length === 0) {
    workflowList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📹</div>
        <div>No workflows yet.<br>Click Record to create one.</div>
      </div>
    `;
    return;
  }

  workflowList.innerHTML = workflows.map(w => `
    <div class="workflow-item" data-id="${w.id}">
      <div class="workflow-info">
        <div class="workflow-name">${escapeHtml(w.name)}</div>
        <div class="workflow-meta">${w.steps.length} steps · ${formatDate(w.createdAt)}</div>
      </div>
      <div class="workflow-actions">
        <button class="btn-play" data-action="play" data-id="${w.id}" title="Replay">▶</button>
        <button class="btn-share" data-action="share" data-id="${w.id}" title="Share Link">🔗</button>
        <button class="btn-export" data-action="export" data-id="${w.id}" title="Export JSON">↓</button>
        <button class="btn-delete" data-action="delete" data-id="${w.id}" title="Delete">✕</button>
      </div>
    </div>
  `).join('');
}

async function handleWorkflowAction(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'play':
      currentState = await sendMessage({ type: 'START_REPLAY', workflowId: id });
      if (currentState?.error) {
        showNotice(`Replay failed: ${currentState.error}`, 'error');
        return;
      }
      currentState.mode = 'replaying';
      renderControls();
      window.close();
      break;

    case 'share':
      await shareWorkflow(id);
      break;

    case 'export':
      await exportWorkflow(id);
      break;

    case 'delete':
      await sendMessage({ type: 'DELETE_WORKFLOW', workflowId: id });
      await loadWorkflows();
      break;
  }
}

async function exportWorkflow(id) {
  const workflows = await sendMessage({ type: 'GET_WORKFLOWS' });
  const workflow = workflows.find(w => w.id === id);
  if (!workflow) return;

  const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trigger-${workflow.name.replace(/[^a-z0-9]/gi, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function shareWorkflow(id) {
  const workflows = await sendMessage({ type: 'GET_WORKFLOWS' });
  const workflow = workflows.find(w => w.id === id);
  if (!workflow) return;

  // Prefer backend-generated share URL when present.
  let shareUrl = workflow.shareUrl;

  // Fallback for local-only mode if backend is unavailable.
  if (!shareUrl) {
    const viewerUrl = await getViewerUrl();
    if (!viewerUrl) {
      showNotice('No viewer URL configured. Open settings to set one.', 'error');
      return;
    }

    const backendUrl = await getBackendUrl();
    const workflowJson = JSON.stringify(workflow);
    const encoded = encodeURIComponent(workflowJson);
    shareUrl = `${viewerUrl}?workflow=${encoded}`;
    if (backendUrl) {
      shareUrl += `&backend_url=${encodeURIComponent(backendUrl)}`;
    }
  }

  // Try to copy to clipboard
  try {
    await navigator.clipboard.writeText(shareUrl);
    showNotice(`Share link copied to clipboard: ${shareUrl}`, 'success', 12000);
  } catch (err) {
    // Fallback: keep the URL visible in popup if clipboard is blocked.
    showNotice(`Clipboard blocked. Copy this link: ${shareUrl}`, 'info', 20000);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function getBackendUrl() {
  const result = await chrome.storage.sync.get('backendUrl');
  return sanitizeUrl(result.backendUrl) || null;
}

async function getViewerUrl() {
  const result = await chrome.storage.sync.get('viewerUrl');
  return sanitizeUrl(result.viewerUrl) || null;
}

async function configureShareSettings() {
  const currentBackend = await getBackendUrl();
  const currentViewer = await getViewerUrl();

  const backendInput = window.prompt(
    'Backend URL (origin only). Leave blank to disable backend upload:',
    currentBackend || ''
  );
  if (backendInput === null) return;

  const viewerInput = window.prompt(
    'Viewer URL (origin only). Needed for URL-embedded sharing fallback:',
    currentViewer || ''
  );
  if (viewerInput === null) return;

  const backendSanitized = backendInput.trim() ? sanitizeUrl(backendInput.trim()) : null;
  const viewerSanitized = viewerInput.trim() ? sanitizeUrl(viewerInput.trim()) : null;

  if (backendInput.trim() && !backendSanitized) {
    showNotice('Invalid backend URL. Use http://host:port or https://host', 'error');
    return;
  }
  if (viewerInput.trim() && !viewerSanitized) {
    showNotice('Invalid viewer URL. Use http://host or https://host', 'error');
    return;
  }

  if (backendSanitized) {
    const result = await sendMessage({ type: 'SET_BACKEND_URL', backendUrl: backendSanitized });
    if (result?.error) {
      showNotice(`Failed to save backend URL: ${result.error}`, 'error');
      return;
    }
  } else {
    await chrome.storage.sync.remove('backendUrl');
  }

  if (viewerSanitized) {
    await chrome.storage.sync.set({ viewerUrl: viewerSanitized });
  } else {
    await chrome.storage.sync.remove('viewerUrl');
  }

  showNotice('Share settings saved', 'success');
}

function showNotice(message, type = 'info', timeoutMs = 6000) {
  if (!notice) return;
  notice.className = `notice ${type}`;
  notice.textContent = message;
  notice.style.display = 'block';

  if (showNotice.timer) {
    clearTimeout(showNotice.timer);
  }
  showNotice.timer = setTimeout(() => {
    notice.style.display = 'none';
  }, timeoutMs);
}

function sanitizeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (err) {
    return null;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString();
}

// ── Start ──────────────────────────────────────────────────────────
init();
