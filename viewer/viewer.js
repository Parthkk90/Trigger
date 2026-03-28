/**
 * Trigger Replay Viewer
 * Web-based workflow viewer and executor
 *
 * Features:
 * - Upload workflow JSON files
 * - Parse JSON from text input
 * - Load workflow from URL parameter (?workflow=...)
 * - Detect extension presence before replay
 * - Show install prompt if extension not detected
 * - Auto-proceed when extension becomes available
 */

// ── Configuration ─────────────────────────────────────────────────
const DEFAULT_API_BASE_URL = getDefaultApiBaseUrl();
const API_BASE_URL = resolveBackendBaseUrl();
const EXTENSION_INSTALL_URL = 'https://chromewebstore.google.com/';

// ── DOM Elements ──────────────────────────────────────────────────
const messageEl = document.getElementById('message');
const alertEl = document.getElementById('alert');
const fileUploadArea = document.getElementById('fileUploadArea');
const fileInput = document.getElementById('fileInput');
const jsonInput = document.getElementById('jsonInput');
const previewContent = document.getElementById('previewContent');
const previewEmpty = document.getElementById('previewEmpty');
const workflowSummary = document.getElementById('workflowSummary');
const stepList = document.getElementById('stepList');

let currentWorkflow = null;
let extensionDetected = false;
let extensionPollInterval = null;

// ── Initialize ────────────────────────────────────────────────────

function init() {
  setupTabSwitching();
  setupFileUpload();
  setupJsonParsing();
  setupUrlParameterLoading();
  setupWorkflowExecution();
  checkUrlForWorkflowData();
}

// ── Tab Switching ─────────────────────────────────────────────────

function setupTabSwitching() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;

      // Update active button
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update active content
      document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.remove('active');
      });
      document.getElementById(tabName).classList.add('active');
    });
  });
}

// ── File Upload Handling ──────────────────────────────────────────

function setupFileUpload() {
  // Click to browse
  fileUploadArea.addEventListener('click', () => fileInput.click());

  // File selection
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) parseFile(file);
  });

  // Drag and drop
  fileUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileUploadArea.classList.add('dragging');
  });

  fileUploadArea.addEventListener('dragleave', () => {
    fileUploadArea.classList.remove('dragging');
  });

  fileUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    fileUploadArea.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/json') {
      parseFile(file);
    } else {
      showMessage('Please drop a JSON file', 'error');
    }
  });

  // Load from URL parameter button
  document.getElementById('btnLoadFromUrl').addEventListener('click', loadFromUrlParameter);
}

/**
 * Parses a workflow JSON file and displays preview
 * @param {File} file - The JSON file to parse
 */
function parseFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const workflow = JSON.parse(e.target.result);
      validateAndLoadWorkflow(workflow);
    } catch (err) {
      showMessage('Invalid JSON: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// ── JSON Parsing ──────────────────────────────────────────────────

function setupJsonParsing() {
  document.getElementById('btnParseJson').addEventListener('click', () => {
    const text = jsonInput.value.trim();
    if (!text) {
      showMessage('Please paste JSON content', 'error');
      return;
    }

    try {
      const workflow = JSON.parse(text);
      validateAndLoadWorkflow(workflow);
    } catch (err) {
      showMessage('Invalid JSON: ' + err.message, 'error');
    }
  });
}

// ── URL Parameter Loading ─────────────────────────────────────────

function setupUrlParameterLoading() {
  // Handled in checkUrlForWorkflowData
}

/**
 * Checks URL for workflow data or slug parameter
 * Supports: ?workflow=<encoded-json> or ?slug=<share-slug>
 */
function checkUrlForWorkflowData() {
  const params = new URLSearchParams(window.location.search);

  // Load from ?workflow=<encoded-json>
  const workflowParam = params.get('workflow');
  if (workflowParam) {
    try {
      const workflow = JSON.parse(decodeURIComponent(workflowParam));
      validateAndLoadWorkflow(workflow);
    } catch (err) {
      showMessage('Invalid workflow parameter: ' + err.message, 'error');
    }
    return;
  }

  // Load from ?slug=<share-slug> (backend endpoint)
  const slugParam = params.get('slug');
  if (slugParam) {
    loadWorkflowFromBackend(slugParam);
    return;
  }
}

function resolveBackendBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('backend_url');
  const sanitized = sanitizeBaseUrl(fromQuery);
  return sanitized || DEFAULT_API_BASE_URL;
}

function getDefaultApiBaseUrl() {
  try {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return window.location.origin;
    }
  } catch (err) {
    // Ignore and use null fallback below.
  }
  return null;
}

function sanitizeBaseUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (err) {
    return null;
  }
}

/**
 * Loads workflow from backend by slug
 * @param {string} slug - The workflow share slug
 */
async function loadWorkflowFromBackend(slug) {
  showMessage('Loading workflow...', 'info');

  if (!API_BASE_URL) {
    showMessage('Backend URL is not configured. Add backend_url query param to use ?slug= links.', 'error');
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${API_BASE_URL}/api/links/${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error('Failed to load workflow: ' + response.status);
    }

    const data = await response.json();
    if (!data || typeof data !== 'object') {
      throw new Error('Malformed backend response: expected object payload');
    }
    if (!data.workflow || typeof data.workflow !== 'object') {
      throw new Error('Malformed backend response: missing workflow object');
    }
    if (!Array.isArray(data.workflow.steps)) {
      throw new Error('Malformed backend response: workflow.steps must be an array');
    }

    validateAndLoadWorkflow(data.workflow);
  } catch (err) {
    if (err.name === 'AbortError') {
      showMessage('Request timed out after 10 seconds. Please retry.', 'error');
      return;
    }
    showMessage(err.message, 'error');
  }
}

function loadFromUrlParameter() {
  const params = new URLSearchParams(window.location.search);
  const workflowParam = params.get('workflow');
  const slugParam = params.get('slug');

  if (workflowParam) {
    try {
      const workflow = JSON.parse(decodeURIComponent(workflowParam));
      validateAndLoadWorkflow(workflow);
      return;
    } catch (err) {
      showMessage('Invalid workflow parameter: ' + err.message, 'error');
      return;
    }
  }

  if (slugParam) {
    loadWorkflowFromBackend(slugParam);
    return;
  }

  showMessage('No workflow parameter found in URL. Add ?workflow=<json> or ?slug=<slug>', 'error');
}

// ── Workflow Validation & Loading ─────────────────────────────────

/**
 * Validates a workflow object and loads it into the preview
 * @param {Object} workflow - The workflow object to validate
 */
function validateAndLoadWorkflow(workflow) {
  // Basic validation
  if (!workflow || typeof workflow !== 'object') {
    showMessage('Invalid workflow: must be an object', 'error');
    return;
  }
  if (!workflow.id) {
    showMessage('Invalid workflow: missing id', 'error');
    return;
  }
  if (!Array.isArray(workflow.steps)) {
    showMessage('Invalid workflow: steps must be an array', 'error');
    return;
  }
  if (!workflow.name) {
    showMessage('Invalid workflow: missing name', 'error');
    return;
  }

  currentWorkflow = workflow;
  displayPreview(workflow);
  showMessage('Workflow loaded: ' + workflow.name, 'success');
}

// ── Preview Display ───────────────────────────────────────────────

/**
 * Displays workflow preview with summary and step list
 * @param {Object} workflow - The workflow to display
 */
function displayPreview(workflow) {
  previewEmpty.style.display = 'none';
  previewContent.style.display = 'block';

  // Build summary
  workflowSummary.innerHTML = `
    <div class="summary-row">
      <span class="summary-label">Name:</span>
      <span class="summary-value">${escapeHtml(workflow.name)}</span>
    </div>
    <div class="summary-row">
      <span class="summary-label">Steps:</span>
      <span class="summary-value">${workflow.steps.length}</span>
    </div>
    <div class="summary-row">
      <span class="summary-label">Start URL:</span>
      <span class="summary-value">${escapeHtml(workflow.startUrl || 'N/A')}</span>
    </div>
    <div class="summary-row">
      <span class="summary-label">Created:</span>
      <span class="summary-value">${new Date(workflow.createdAt).toLocaleString()}</span>
    </div>
  `;

  // Build step list
  stepList.innerHTML = '<h3 style="margin-bottom: 12px;">Steps</h3>';
  workflow.steps.forEach((step, i) => {
    const stepEl = document.createElement('div');
    stepEl.className = 'step-item';

    let detail = '';
    let targetHtml = '';

    switch (step.type) {
      case 'navigate':
        detail = escapeHtml(step.url);
        break;
      case 'click':
        detail = step.target?.text || step.target?.ariaLabel || 'Click element';
        targetHtml = buildTargetHtml(step.target);
        break;
      case 'input':
        detail = `Type: "${step.value}" into ${step.target?.name || step.target?.placeholder || 'field'}`;
        targetHtml = buildTargetHtml(step.target);
        break;
      case 'select':
        detail = `Select "${step.value}"`;
        targetHtml = buildTargetHtml(step.target);
        break;
      case 'check':
        detail = step.checked ? 'Check' : 'Uncheck';
        targetHtml = buildTargetHtml(step.target);
        break;
      case 'keypress':
        detail = `Press ${step.key}`;
        targetHtml = buildTargetHtml(step.target);
        break;
      default:
        detail = JSON.stringify(step);
    }

    stepEl.innerHTML = `
      <span class="step-type">${step.type}</span>
      <span>Step ${i + 1}: ${detail}</span>
      ${targetHtml ? `<div class="step-target">${targetHtml}</div>` : ''}
    `;

    stepList.appendChild(stepEl);
  });

  // Show execute button
  const btnExecute = document.getElementById('btnExecuteWorkflow');
  if (btnExecute) {
    btnExecute.style.display = 'inline-block';
  }
}

/**
 * Builds HTML representation of a step target fingerprint
 * @param {Object} target - The target fingerprint object
 * @returns {string} HTML string
 */
function buildTargetHtml(target) {
  if (!target) return '';

  const fields = [];
  if (target.ariaLabel) fields.push(['ARIA', target.ariaLabel]);
  if (target.name) fields.push(['Name', target.name]);
  if (target.placeholder) fields.push(['Placeholder', target.placeholder]);
  if (target.text) fields.push(['Text', target.text]);
  if (target.selector) fields.push(['Selector', target.selector]);

  if (fields.length === 0) return '';

  return fields.map(([key, val]) => `
    <div>
      <span class="step-target-key">${key}:</span>
      <span class="step-target-value">${escapeHtml(val)}</span>
    </div>
  `).join('');
}

// ── Workflow Execution ────────────────────────────────────────────

function setupWorkflowExecution() {
  // Execute on current page
  document.getElementById('btnExecuteWorkflow').addEventListener('click', () => {
    executeWorkflowInline();
  });

  // Open in new tab
  document.getElementById('btnOpenInNewTab').addEventListener('click', () => {
    if (currentWorkflow?.startUrl) {
      window.open(currentWorkflow.startUrl, '_blank');
    } else {
      showMessage('No start URL defined', 'error');
    }
  });
}

/**
 * Detects if the Trigger extension is installed
 * Uses chrome.runtime.sendMessage with timeout fallback
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>} True if extension responds
 */
function detectExtension(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, timeoutMs);

    // Try to send a ping message to the extension
    // The extension should have a handler for a PING message type
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage(
        { type: 'EXTENSION_PING' },
        (response) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(!!response && response.ok !== undefined);
          }
        }
      );
    } else {
      resolved = true;
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * Shows the extension install prompt
 */
function showInstallPrompt() {
  alertEl.innerHTML = `
    <span class="close-btn" onclick="this.parentElement.style.display='none'">&times;</span>
    <strong>Extension Required</strong><br>
    The Trigger extension is not detected in this browser.
    <br><br>
    <a href="${EXTENSION_INSTALL_URL}" target="_blank" rel="noreferrer" style="display: inline-block; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Install Trigger Extension</a>
  `;
  alertEl.className = 'alert alert-warning show';
}

/**
 * Polls for extension presence every 3 seconds
 * Auto-proceeds when extension is detected
 */
function startExtensionPolling() {
  if (extensionPollInterval) {
    clearInterval(extensionPollInterval);
  }

  extensionPollInterval = setInterval(async () => {
    const detected = await detectExtension(1000);
    if (detected) {
      extensionDetected = true;
      clearInterval(extensionPollInterval);
      extensionPollInterval = null;

      alertEl.style.display = 'none';
      showMessage('Extension detected! Ready to execute.', 'success');

      // Auto-execute the workflow
      executeWorkflowInline();
    }
  }, 3000);
}

/**
 * Executes the workflow inline on the current page
 * Sends the workflow to the extension via message
 */
async function executeWorkflowInline() {
  if (!currentWorkflow) {
    showMessage('No workflow loaded', 'error');
    return;
  }

  // First, check if extension is present
  const detected = await detectExtension(2000);

  if (!detected) {
    extensionDetected = false;
    showInstallPrompt();
    startExtensionPolling();
    return;
  }

  extensionDetected = true;

  // Send workflow to extension for inline replay
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_REPLAY_INLINE',
      workflow: currentWorkflow,
    });

    if (response?.error) {
      showMessage('Extension error: ' + response.error, 'error');
      return;
    }

    if (response?.type === 'WAITING_NAVIGATION') {
      showMessage('Workflow started. Navigate to start URL...', 'info');
    } else if (response?.type === 'REPLAY_COMPLETE') {
      showMessage('Workflow has no steps', 'info');
    } else {
      showMessage('Workflow execution started!', 'success');
    }
  } catch (err) {
    showMessage('Failed to communicate with extension: ' + err.message, 'error');
  }
}

// ── Message Display ───────────────────────────────────────────────

/**
 * Shows a message in the message area
 * @param {string} text - Message text
 * @param {string} type - Message type: 'success', 'error', 'info'
 */
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type} show`;

  // Auto-hide success messages after 5 seconds
  if (type === 'success') {
    setTimeout(() => {
      messageEl.classList.remove('show');
    }, 5000);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Escapes HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Start ─────────────────────────────────────────────────────────

init();
