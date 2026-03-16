/**
 * Trigger — Popup Script
 * Controls the extension popup UI: start/stop recording, manage workflows.
 */

const btnRecord = document.getElementById('btn-record');
const controls = document.getElementById('controls');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const workflowList = document.getElementById('workflow-list');
const btnSettings = document.getElementById('btn-settings');

const DEFAULT_BACKEND_URL = 'http://localhost:8787';

let currentState = null;

// ── Initialize ─────────────────────────────────────────────────────

async function init() {
  currentState = await sendMessage({ type: 'GET_STATE' });
  renderControls();

  // Set up event delegation once
  workflowList.addEventListener('click', handleWorkflowAction);
  btnSettings.addEventListener('click', configureBackendUrl);

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
        alert(`Replay failed: ${currentState.error}`);
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
    const viewerUrl = 'http://localhost:8080';
    const backendUrl = await getBackendUrl();
    const workflowJson = JSON.stringify(workflow);
    const encoded = encodeURIComponent(workflowJson);
    shareUrl = `${viewerUrl}?workflow=${encoded}&backend_url=${encodeURIComponent(backendUrl)}`;
  }

  // Try to copy to clipboard
  try {
    await navigator.clipboard.writeText(shareUrl);
    alert(`✓ Share link copied to clipboard!\n\n${shareUrl}`);
  } catch (err) {
    // Fallback: show the URL in a dialog
    alert(`Share this link:\n\n${shareUrl}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function getBackendUrl() {
  const result = await chrome.storage.sync.get('backendUrl');
  return sanitizeUrl(result.backendUrl) || DEFAULT_BACKEND_URL;
}

async function configureBackendUrl() {
  const current = await getBackendUrl();
  const entered = window.prompt('Backend URL (origin only):', current);
  if (entered === null) return;

  const sanitized = sanitizeUrl(entered);
  if (!sanitized) {
    alert('Invalid URL. Use http://host:port or https://host');
    return;
  }

  const result = await sendMessage({ type: 'SET_BACKEND_URL', backendUrl: sanitized });
  if (result?.error) {
    alert(`Failed to save URL: ${result.error}`);
    return;
  }
  alert(`Backend URL saved: ${sanitized}`);
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
