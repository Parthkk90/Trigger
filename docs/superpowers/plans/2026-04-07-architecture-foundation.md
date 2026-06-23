# Architecture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an esbuild build pipeline, restructure source into ES modules with shared code, and decompose the service worker into focused modules - with zero behavioral changes.

**Architecture:** Source moves to `src/`, esbuild bundles 6 targets to `dist/`. Shared modules (`fingerprint`, `workflow-schema`, `constants`, `config`) are imported by extension, viewer, and cloud worker. Service worker splits from 1 file into 5 focused modules.

**Tech Stack:** JavaScript (ES modules), esbuild (bundler), jsdom (testing)

---

## File Map

### New files to create

| File | Responsibility |
|------|---------------|
| `scripts/build.js` | esbuild build config - 6 targets, asset copy, manifest patching, watch mode |
| `src/shared/constants.js` | All hardcoded threshold/timing values |
| `src/shared/workflow-schema.js` | Workflow validation, failure classification, step types |
| `src/shared/fingerprint.js` | Fingerprint generation, resolution, scoring |
| `src/shared/config.js` | Runtime config (backend URL) with environment-aware getters |
| `src/extension/background/storage.js` | Storage abstraction: session, workflow CRUD, state persistence |
| `src/extension/background/upload-queue.js` | Upload retry queue with exponential backoff |
| `src/extension/background/recording.js` | Recording message handlers + ID generation |
| `src/extension/background/replay-state.js` | Replay state machine, recovery, credentials, freshness |

### Files to move (no code changes initially)

| From | To |
|------|-----|
| `extension/content/fingerprint.js` | `src/extension/content/fingerprint.js` |
| `extension/content/overlay.js` | `src/extension/content/overlay.js` |
| `extension/content/recorder.js` | `src/extension/content/recorder.js` |
| `extension/content/replay.js` | `src/extension/content/replay.js` |
| `extension/content/injector.js` | `src/extension/content/index.js` |
| `extension/background/service-worker.js` | `src/extension/background/service-worker.js` |
| `extension/popup/popup.js` | `src/extension/popup/popup.js` |
| `extension/popup/popup.html` | `src/extension/popup/popup.html` |
| `extension/manifest.json` | `src/extension/manifest.json` |
| `extension/styles/tokens.css` | `src/extension/styles/tokens.css` |
| `extension/icons/*` | `src/extension/icons/*` |
| `backend/*` | `src/backend/*` |
| `viewer/*` | `src/viewer/*` |
| `workers/*` | `src/workers/*` |

### Files to modify

| File | Change |
|------|--------|
| `src/extension/background/service-worker.js` | Becomes thin entry point: imports modules, message router, keepalive |
| `src/extension/content/index.js` | Imports from shared modules, bridges to `window.Trigger` |
| `src/extension/content/fingerprint.js` | Exports functions via ES module syntax |
| `src/extension/content/recorder.js` | Imports from shared fingerprint |
| `src/extension/content/replay.js` | Imports from shared constants + fingerprint |
| `src/extension/content/overlay.js` | Imports from shared constants |
| `src/extension/popup/popup.js` | No changes (standalone) |
| `src/viewer/viewer.js` | Imports from shared workflow-schema |
| `src/workers/replay-worker.js` | Imports from shared constants |
| `tests/run-tests.js` | Update file paths to `src/extension/` |
| `tests/test-backend.js` | Update file paths to `src/backend/` |
| `tests/test-viewer.js` | Update file paths to `src/viewer/` |
| `package.json` | Add esbuild, update scripts |
| `.gitignore` | Add `dist/` |

---

## Task 1: Install esbuild and create build script

**Files:**
- Modify: `package.json`
- Create: `scripts/build.js`
- Modify: `.gitignore`

- [ ] **Step 1: Install esbuild**

```bash
npm install --save-dev esbuild
```

- [ ] **Step 2: Add `dist/` to `.gitignore`**

Append to `.gitignore`:

```
dist/
```

- [ ] **Step 3: Create `scripts/build.js`**

```js
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const isWatch = process.argv.includes('--watch');

// ── Asset Copying ──────────────────────────────────────────────────

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyAssets() {
  // Manifest - patch content_scripts to use single bundle
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SRC, 'extension', 'manifest.json'), 'utf8')
  );
  manifest.content_scripts[0].js = ['content/content.js'];
  fs.mkdirSync(path.join(DIST, 'extension'), { recursive: true });
  fs.writeFileSync(
    path.join(DIST, 'extension', 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // popup.html
  fs.mkdirSync(path.join(DIST, 'extension', 'popup'), { recursive: true });
  fs.copyFileSync(
    path.join(SRC, 'extension', 'popup', 'popup.html'),
    path.join(DIST, 'extension', 'popup', 'popup.html')
  );

  // icons
  const iconsDir = path.join(SRC, 'extension', 'icons');
  if (fs.existsSync(iconsDir)) {
    copyDir(iconsDir, path.join(DIST, 'extension', 'icons'));
  }

  // styles
  const stylesDir = path.join(SRC, 'extension', 'styles');
  if (fs.existsSync(stylesDir)) {
    copyDir(stylesDir, path.join(DIST, 'extension', 'styles'));
  }

  // viewer HTML
  fs.mkdirSync(path.join(DIST, 'viewer'), { recursive: true });
  const viewerHtml = path.join(SRC, 'viewer', 'index.html');
  if (fs.existsSync(viewerHtml)) {
    fs.copyFileSync(viewerHtml, path.join(DIST, 'viewer', 'index.html'));
  }

  // backend data dir and migrations
  const backendDirs = ['data', 'migrations'];
  for (const dir of backendDirs) {
    const src = path.join(SRC, 'backend', dir);
    if (fs.existsSync(src)) {
      copyDir(src, path.join(DIST, 'backend', dir));
    }
  }
}

// ── Build Targets ──────────────────────────────────────────────────

const targets = [
  {
    name: 'content',
    entryPoints: [path.join(SRC, 'extension', 'content', 'index.js')],
    outfile: path.join(DIST, 'extension', 'content', 'content.js'),
    format: 'iife',
    platform: 'browser',
  },
  {
    name: 'service-worker',
    entryPoints: [path.join(SRC, 'extension', 'background', 'service-worker.js')],
    outfile: path.join(DIST, 'extension', 'background', 'service-worker.js'),
    format: 'esm',
    platform: 'browser',
  },
  {
    name: 'popup',
    entryPoints: [path.join(SRC, 'extension', 'popup', 'popup.js')],
    outfile: path.join(DIST, 'extension', 'popup', 'popup.js'),
    format: 'iife',
    platform: 'browser',
  },
  {
    name: 'viewer',
    entryPoints: [path.join(SRC, 'viewer', 'viewer.js')],
    outfile: path.join(DIST, 'viewer', 'viewer.js'),
    format: 'iife',
    platform: 'browser',
  },
  {
    name: 'backend',
    entryPoints: [path.join(SRC, 'backend', 'server.js')],
    outfile: path.join(DIST, 'backend', 'server.js'),
    format: 'cjs',
    platform: 'node',
    external: ['pg', 'fastify', '@fastify/cors', 'nanoid', 'bullmq'],
  },
  {
    name: 'worker',
    entryPoints: [path.join(SRC, 'workers', 'replay-worker.js')],
    outfile: path.join(DIST, 'workers', 'replay-worker.js'),
    format: 'cjs',
    platform: 'node',
    external: ['playwright', 'bullmq'],
  },
];

// ── Main ───────────────────────────────────────────────────────────

async function build() {
  // Clean dist
  fs.rmSync(DIST, { recursive: true, force: true });

  // Copy static assets
  copyAssets();

  // Build all targets in parallel
  const start = Date.now();
  const contexts = [];

  for (const target of targets) {
    const options = {
      entryPoints: target.entryPoints,
      outfile: target.outfile,
      format: target.format,
      platform: target.platform,
      bundle: true,
      sourcemap: false,
      external: target.external || [],
      logLevel: 'warning',
    };

    if (isWatch) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
      contexts.push(ctx);
      console.log(`  [watch] ${target.name}`);
    } else {
      await esbuild.build(options);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`Build complete in ${elapsed}ms`);

  if (isWatch) {
    console.log('Watching for changes...');
    // Keep process alive
    process.on('SIGINT', () => {
      contexts.forEach(ctx => ctx.dispose());
      process.exit(0);
    });
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Update npm scripts in `package.json`**

Replace the `"scripts"` section:

```json
{
  "build": "node scripts/build.js",
  "build:watch": "node scripts/build.js --watch",
  "dev": "node scripts/build.js --watch",
  "test": "node tests/run-tests.js && node tests/test-recovery.js && node tests/test-smoke.js",
  "test:extension": "node tests/run-tests.js",
  "test:recovery": "node tests/test-recovery.js",
  "test:smoke": "node tests/test-smoke.js",
  "test:viewer": "node tests/test-viewer.js",
  "test:backend": "node tests/test-backend.js",
  "test:all": "npm test && npm run test:viewer && npm run test:backend",
  "backend:start": "node src/backend/server.js",
  "worker:start": "node src/workers/replay-worker.js"
}
```

- [ ] **Step 5: Verify build script runs (will fail since `src/` doesn't exist yet - expected)**

```bash
node scripts/build.js
```

Expected: fails with ENOENT for `src/extension/...` - confirms the script runs and the asset/target config is wired correctly.

- [ ] **Step 6: Commit**

```bash
git add scripts/build.js .gitignore package.json package-lock.json
git commit -m "add esbuild build pipeline scaffolding"
```

---

## Task 2: Move source files to `src/`

**Files:**
- Move: all source files from `extension/`, `backend/`, `viewer/`, `workers/` to `src/`
- Modify: `tests/run-tests.js`, `tests/test-backend.js`, `tests/test-viewer.js`, `tests/test-smoke.js`

- [ ] **Step 1: Create `src/` directory structure and move files**

```bash
# Extension
mkdir -p src/extension/content src/extension/background src/extension/popup src/extension/icons src/extension/styles
cp extension/content/fingerprint.js src/extension/content/fingerprint.js
cp extension/content/overlay.js src/extension/content/overlay.js
cp extension/content/recorder.js src/extension/content/recorder.js
cp extension/content/replay.js src/extension/content/replay.js
cp extension/content/injector.js src/extension/content/index.js
cp extension/background/service-worker.js src/extension/background/service-worker.js
cp extension/popup/popup.js src/extension/popup/popup.js
cp extension/popup/popup.html src/extension/popup/popup.html
cp extension/manifest.json src/extension/manifest.json
cp -r extension/icons/* src/extension/icons/
cp -r extension/styles/* src/extension/styles/

# Backend
mkdir -p src/backend
cp backend/server.js src/backend/server.js
cp backend/package.json src/backend/package.json
cp backend/cloud-replay.js src/backend/cloud-replay.js
cp backend/migrate.js src/backend/migrate.js
cp backend/migration-runner.js src/backend/migration-runner.js
cp backend/rollback.js src/backend/rollback.js
cp -r backend/data src/backend/data 2>/dev/null || true
cp -r backend/migrations src/backend/migrations

# Viewer
mkdir -p src/viewer
cp viewer/viewer.js src/viewer/viewer.js
cp viewer/index.html src/viewer/index.html

# Workers
mkdir -p src/workers
cp workers/replay-worker.js src/workers/replay-worker.js

# Shared (empty for now)
mkdir -p src/shared
```

- [ ] **Step 2: Update test file paths in `tests/run-tests.js`**

In `tests/run-tests.js`, the `loadContentScripts` function at line ~169 reads files from `extension/`. Change the base path:

Find:
```js
    const code = fs.readFileSync(
      path.join(__dirname, '..', 'extension', file),
      'utf8'
    );
```

Replace with:
```js
    const code = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'extension', file),
      'utf8'
    );
```

Also find `loadInjectorScript` at line ~189:
```js
  const code = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'content', 'injector.js'),
    'utf8'
  );
```

Replace with:
```js
  const code = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension', 'content', 'index.js'),
    'utf8'
  );
```

Search the rest of the test file for any other `'extension'` path references and update them to `'src', 'extension'`. Also update any references to `'backend'` to `'src', 'backend'` and `'viewer'` to `'src', 'viewer'`.

- [ ] **Step 3: Update test file paths in `tests/test-backend.js`**

Find all `path.join(__dirname, '..', 'backend',` and replace with `path.join(__dirname, '..', 'src', 'backend',`.

- [ ] **Step 4: Update test file paths in `tests/test-viewer.js`**

Find all `path.join(__dirname, '..', 'viewer',` and replace with `path.join(__dirname, '..', 'src', 'viewer',`.

- [ ] **Step 5: Update test file paths in `tests/test-smoke.js`**

Find all references to `extension/`, `backend/`, `viewer/`, `workers/` paths and update to `src/extension/`, `src/backend/`, `src/viewer/`, `src/workers/`.

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: all existing tests pass with updated paths.

- [ ] **Step 7: Verify build produces loadable extension**

```bash
npm run build
```

Then verify `dist/extension/` contains:
- `manifest.json` (with `content/content.js` in content_scripts)
- `content/content.js`
- `background/service-worker.js`
- `popup/popup.js`
- `popup/popup.html`
- `icons/` directory
- `styles/` directory

- [ ] **Step 8: Commit**

```bash
git add src/ tests/ package.json
git commit -m "move source files to src/ and update test paths"
```

---

## Task 3: Extract `src/shared/constants.js`

**Files:**
- Create: `src/shared/constants.js`

- [ ] **Step 1: Create `src/shared/constants.js`**

```js
/**
 * Trigger - Shared Constants
 * Single source of truth for thresholds, timing values, and limits.
 */

// Confidence thresholds
export const CONFIDENCE_AUTO = 85;
export const CONFIDENCE_SHOW = 50;

// Replay timing
export const STEP_DELAY_MS = 300;
export const ELEMENT_WAIT_MS = 5000;
export const ELEMENT_POLL_MS = 200;
export const NAV_AUTH_SETTLE_MS = 500;

// Keepalive & recovery
export const KEEPALIVE_INTERVAL_MS = 20000;
export const REPLAY_HEARTBEAT_STALE_MS = 45000;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const MAX_STEP_RETRIES = 3;
export const REPLAY_FRESHNESS_THRESHOLD = 60;

// Upload retry
export const UPLOAD_MAX_RETRIES = 5;
export const UPLOAD_INITIAL_BACKOFF_MS = 2000;
export const UPLOAD_QUEUE_KEY = 'uploadRetryQueue';

// Screenshot
export const SCREENSHOT_CAPTURE_TIMEOUT_MS = 1500;
```

- [ ] **Step 2: Verify build still works**

```bash
npm run build
```

Expected: builds successfully (constants.js isn't imported yet, but must be valid syntax).

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.js
git commit -m "add shared constants module"
```

---

## Task 4: Extract `src/shared/workflow-schema.js`

**Files:**
- Create: `src/shared/workflow-schema.js`

- [ ] **Step 1: Create `src/shared/workflow-schema.js`**

Extract from `src/extension/background/service-worker.js` lines ~279-319:

```js
/**
 * Trigger - Workflow Schema Utilities
 * Validation, failure classification, and step type helpers.
 */

export const STEP_TYPES = ['click', 'input', 'select', 'check', 'keypress', 'navigate'];

export function validateReplayWorkflow(workflow) {
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

export function buildReplayFreshnessSample(steps) {
  var sample = [];
  for (var i = 0; i < steps.length && sample.length < 3; i += 1) {
    var step = steps[i];
    if (!step || !step.target) continue;
    sample.push({ ...step, index: typeof step.index === 'number' ? step.index : i });
  }
  return sample;
}

export function classifyFailure(reason, reasonType) {
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

export function isRetryableFailure(reasonType) {
  return reasonType === 'selector_not_found' || reasonType === 'navigation_timeout' || reasonType === 'unknown_error';
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/workflow-schema.js
git commit -m "add shared workflow-schema module"
```

---

## Task 5: Extract `src/shared/config.js`

**Files:**
- Create: `src/shared/config.js`

- [ ] **Step 1: Create `src/shared/config.js`**

```js
/**
 * Trigger - Runtime Configuration
 * Environment-aware getters for backend URL and other config.
 */

export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    var parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (err) {
    return null;
  }
}

/**
 * Get the backend base URL based on the execution context.
 * @param {'extension'|'viewer'|'backend'|'worker'} context
 * @returns {Promise<string|null>}
 */
export async function getBackendUrl(context) {
  if (context === 'extension') {
    var _browser = typeof browser !== 'undefined' ? browser : chrome;
    var result = await _browser.storage.sync.get('backendUrl');
    return sanitizeUrl(result.backendUrl) || null;
  }

  if (context === 'viewer') {
    // When hosted, default to same-origin
    if (typeof window !== 'undefined' && window.location) {
      return window.location.origin;
    }
    return null;
  }

  // Node.js contexts: backend, worker
  if (typeof process !== 'undefined' && process.env) {
    return sanitizeUrl(process.env.BACKEND_URL) || null;
  }

  return null;
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/config.js
git commit -m "add shared config module"
```

---

## Task 6: Extract `src/shared/fingerprint.js`

**Files:**
- Create: `src/shared/fingerprint.js`
- Modify: `src/extension/content/fingerprint.js`

- [ ] **Step 1: Create `src/shared/fingerprint.js`**

Extract the pure logic from `src/extension/content/fingerprint.js`, converting from IIFE + `window.Trigger` to ES module exports. The DOM-dependent functions receive `document` and `window` as parameters rather than using globals:

```js
/**
 * Trigger - Element Fingerprinting Engine (Shared)
 *
 * Generates multi-signal fingerprints for DOM elements during recording,
 * and resolves those fingerprints back to elements during replay.
 */

export const CONFIDENCE_AUTO = 85;
export const CONFIDENCE_SHOW = 50;

// ── Fingerprint Generation ─────────────────────────────────────

export function generateFingerprint(element) {
  var win = element.ownerDocument.defaultView || window;
  var rect = element.getBoundingClientRect();

  return {
    role: element.getAttribute('role') || inferRole(element),
    ariaLabel: element.getAttribute('aria-label') || '',
    text: getVisibleText(element),
    tagName: element.tagName.toLowerCase(),
    inputType: element.type || '',
    name: element.name || '',
    placeholder: element.placeholder || '',
    selector: buildUniqueSelector(element),
    xpath: getXPath(element),
    position: {
      xRatio: rect.left / win.innerWidth,
      yRatio: rect.top / win.innerHeight,
      widthRatio: rect.width / win.innerWidth,
      heightRatio: rect.height / win.innerHeight,
    },
    tagHtml: element.outerHTML.slice(0, 200),
  };
}

// ── Fingerprint Resolution ─────────────────────────────────────

export function resolveFingerprint(fingerprint, doc) {
  doc = doc || document;
  var candidates = gatherCandidates(fingerprint, doc);

  if (candidates.length === 0) {
    return { element: null, confidence: 0 };
  }

  var scored = candidates.map(function (el) {
    return { element: el, score: scoreCandidateMatch(el, fingerprint) };
  });

  scored.sort(function (a, b) { return b.score - a.score; });

  var best = scored[0];
  return {
    element: best.element,
    confidence: Math.min(100, Math.round(best.score)),
  };
}

// ── Candidate Scoring (exported for freshness evaluation) ──────

export function scoreCandidateMatch(element, fp) {
  var score = 0;

  if (fp.ariaLabel && element.getAttribute('aria-label') === fp.ariaLabel) {
    score += 30;
  }
  var elRole = element.getAttribute('role') || inferRole(element);
  if (fp.role && fp.role !== 'generic' && elRole === fp.role) {
    score += 10;
  }

  var elText = getVisibleText(element);
  if (fp.text && elText === fp.text) {
    score += 25;
  } else if (fp.text && elText && elText.indexOf(fp.text) !== -1) {
    score += 12;
  }

  if (fp.tagName === element.tagName.toLowerCase()) {
    score += 5;
  }
  if (fp.name && element.name === fp.name) {
    score += 5;
  }
  if (fp.placeholder && element.placeholder === fp.placeholder) {
    score += 5;
  }

  try {
    if (fp.selector && element.matches(fp.selector)) {
      score += 10;
    }
  } catch (e) { /* invalid selector */ }

  if (fp.position) {
    var win = element.ownerDocument.defaultView || window;
    var rect = element.getBoundingClientRect();
    var elXRatio = rect.left / win.innerWidth;
    var elYRatio = rect.top / win.innerHeight;
    var distance = Math.hypot(elXRatio - fp.position.xRatio, elYRatio - fp.position.yRatio);
    if (distance < 0.05) {
      score += 10;
    } else if (distance < 0.2) {
      score += Math.round(10 * (1 - distance / 0.2));
    }
  }

  if (isElementVisible(element)) {
    score += 5;
  }

  return score;
}

// ── Helpers (private) ──────────────────────────────────────────

function gatherCandidates(fp, doc) {
  var candidates = new Set();

  try {
    var el = doc.querySelector(fp.selector);
    if (el) candidates.add(el);
  } catch (e) { /* invalid selector */ }

  try {
    var result = doc.evaluate(
      fp.xpath, doc, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    if (result.singleNodeValue) candidates.add(result.singleNodeValue);
  } catch (e) { /* invalid xpath */ }

  if (fp.ariaLabel) {
    doc.querySelectorAll('[aria-label="' + CSS.escape(fp.ariaLabel) + '"]')
      .forEach(function (el) { candidates.add(el); });
  }

  if (fp.role && fp.role !== 'generic') {
    doc.querySelectorAll('[role="' + CSS.escape(fp.role) + '"]')
      .forEach(function (el) { candidates.add(el); });
  }

  if (fp.text) {
    var tag = fp.tagName || '*';
    doc.querySelectorAll(tag).forEach(function (el) {
      if (getVisibleText(el) === fp.text) {
        candidates.add(el);
      }
    });
  }

  if (fp.tagName === 'input' || fp.tagName === 'textarea' || fp.tagName === 'select') {
    if (fp.name) {
      doc.querySelectorAll(fp.tagName + '[name="' + CSS.escape(fp.name) + '"]')
        .forEach(function (el) { candidates.add(el); });
    }
    if (fp.placeholder) {
      doc.querySelectorAll(fp.tagName + '[placeholder="' + CSS.escape(fp.placeholder) + '"]')
        .forEach(function (el) { candidates.add(el); });
    }
  }

  if (candidates.size === 0 && fp.position) {
    var win = doc.defaultView || window;
    var expectedX = fp.position.xRatio * win.innerWidth;
    var expectedY = fp.position.yRatio * win.innerHeight;
    var elemAtPoint = doc.elementFromPoint(expectedX, expectedY);
    if (elemAtPoint) candidates.add(elemAtPoint);
    [-20, -10, 10, 20].forEach(function (offset) {
      var nearby = doc.elementFromPoint(expectedX + offset, expectedY + offset);
      if (nearby) candidates.add(nearby);
    });
  }

  return Array.from(candidates);
}

export function getVisibleText(element) {
  var tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    return element.value || element.placeholder || '';
  }
  if (tag === 'select' && element.selectedIndex >= 0) {
    return element.options[element.selectedIndex].text || '';
  }
  var text = element.innerText || element.textContent || '';
  var trimmed = text.trim();
  return trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
}

export function inferRole(element) {
  var tag = element.tagName.toLowerCase();
  if (tag === 'input') {
    if (element.type === 'checkbox') return 'checkbox';
    if (element.type === 'radio') return 'radio';
    if (element.type === 'submit') return 'button';
    return 'textbox';
  }
  var map = {
    a: 'link', button: 'button', textarea: 'textbox', select: 'combobox',
    img: 'img', nav: 'navigation', main: 'main', header: 'banner',
    footer: 'contentinfo', form: 'form', table: 'table',
    ul: 'list', ol: 'list', li: 'listitem',
  };
  return map[tag] || 'generic';
}

function buildUniqueSelector(element) {
  if (element.id) return '#' + CSS.escape(element.id);

  var parts = [];
  var current = element;
  var depth = 0;
  var doc = element.ownerDocument || document;

  while (current && current !== doc.body && depth < 5) {
    var sel = current.tagName.toLowerCase();

    if (current.id) {
      parts.unshift('#' + CSS.escape(current.id));
      break;
    }

    var classes = Array.from(current.classList)
      .filter(function (c) { return !isGeneratedClass(c); })
      .slice(0, 2);

    if (classes.length > 0) {
      sel += classes.map(function (c) { return '.' + CSS.escape(c); }).join('');
    }

    if (current.parentElement) {
      var siblings = Array.from(current.parentElement.children)
        .filter(function (s) { return s.tagName === current.tagName; });
      if (siblings.length > 1) {
        sel += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
    }

    parts.unshift(sel);
    current = current.parentElement;
    depth++;
  }

  return parts.join(' > ');
}

function isGeneratedClass(className) {
  return /^(css-|sc-|_[a-z0-9]{4,}|[a-z]{1,3}[A-Z][a-zA-Z0-9]{3,})/.test(className)
    || /^[a-f0-9]{6,}$/i.test(className);
}

function getXPath(element) {
  if (element.id) return '//*[@id="' + element.id + '"]';

  var parts = [];
  var current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    var idx = 1;
    var sib = current.previousElementSibling;
    while (sib) {
      if (sib.tagName === current.tagName) idx++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(current.tagName.toLowerCase() + '[' + idx + ']');
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

function isElementVisible(element) {
  if (!element.offsetParent && element.tagName !== 'BODY') return false;
  var win = element.ownerDocument.defaultView || window;
  var style = win.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  var rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
```

- [ ] **Step 2: Update `src/extension/content/fingerprint.js` to be a thin bridge**

Replace the entire content with:

```js
/**
 * Trigger - Element Fingerprinting (Content Script Bridge)
 * Imports shared fingerprint engine and exposes on window.Trigger.
 */

import {
  CONFIDENCE_AUTO,
  CONFIDENCE_SHOW,
  generateFingerprint,
  resolveFingerprint,
  scoreCandidateMatch,
} from '../../shared/fingerprint.js';

window.Trigger = window.Trigger || {};

window.Trigger.CONFIDENCE_AUTO = CONFIDENCE_AUTO;
window.Trigger.CONFIDENCE_SHOW = CONFIDENCE_SHOW;
window.Trigger.generateFingerprint = generateFingerprint;
window.Trigger.resolveFingerprint = function (fingerprint) {
  return resolveFingerprint(fingerprint, document);
};
window.Trigger.scoreCandidateMatch = scoreCandidateMatch;
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass. The content script bridge maintains the `window.Trigger` interface that tests depend on.

- [ ] **Step 4: Run build and verify**

```bash
npm run build
```

Expected: `dist/extension/content/content.js` is a single IIFE bundle containing the fingerprint code.

- [ ] **Step 5: Commit**

```bash
git add src/shared/fingerprint.js src/extension/content/fingerprint.js
git commit -m "extract shared fingerprint module with content script bridge"
```

---

## Task 7: Wire shared imports into service worker

**Files:**
- Modify: `src/extension/background/service-worker.js`

This task replaces the inline copies of `validateReplayWorkflow`, `buildReplayFreshnessSample`, `classifyFailure`, `isRetryableFailure`, and constants with imports from shared modules. The service worker is already declared as `"type": "module"` in the manifest, so ES imports work directly.

- [ ] **Step 1: Add imports to top of `src/extension/background/service-worker.js`**

Add these lines after the initial comment block (before the `const _browser` line):

```js
import {
  KEEPALIVE_INTERVAL_MS,
  REPLAY_HEARTBEAT_STALE_MS,
  MAX_RECOVERY_ATTEMPTS,
  REPLAY_FRESHNESS_THRESHOLD,
  UPLOAD_QUEUE_KEY,
  UPLOAD_MAX_RETRIES,
  UPLOAD_INITIAL_BACKOFF_MS,
} from '../../shared/constants.js';

import {
  validateReplayWorkflow,
  buildReplayFreshnessSample,
  classifyFailure,
  isRetryableFailure,
} from '../../shared/workflow-schema.js';

import { sanitizeUrl } from '../../shared/config.js';
```

- [ ] **Step 2: Remove the now-duplicated declarations from service-worker.js**

Remove these lines (they're now imported):

```js
const KEEPALIVE_INTERVAL_MS = 20000;
const REPLAY_HEARTBEAT_STALE_MS = 45000;
const MAX_RECOVERY_ATTEMPTS = 3;
const REPLAY_FRESHNESS_THRESHOLD = 60;
const UPLOAD_QUEUE_KEY = 'uploadRetryQueue';
const UPLOAD_MAX_RETRIES = 5;
const UPLOAD_INITIAL_BACKOFF_MS = 2000;
```

Remove the `validateReplayWorkflow` function definition (~line 279-293).

Remove the `buildReplayFreshnessSample` function definition (~line 295-303).

Remove the `classifyFailure` function definition (~line 305-316).

Remove the `isRetryableFailure` function definition (~line 318-320).

Remove the `sanitizeUrl` function definition (~line 268-277).

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass. Service worker tests load the file via `require`/`Function()` and the tests should still work because the service worker still exposes the same `messageHandlers` object.

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected: esbuild resolves the imports and bundles everything into the service worker output.

- [ ] **Step 5: Commit**

```bash
git add src/extension/background/service-worker.js
git commit -m "wire shared imports into service worker"
```

---

## Task 8: Extract `src/extension/background/storage.js`

**Files:**
- Create: `src/extension/background/storage.js`
- Modify: `src/extension/background/service-worker.js`

- [ ] **Step 1: Create `src/extension/background/storage.js`**

Extract storage-related code from service-worker.js:

```js
/**
 * Trigger - Storage Abstraction
 * Session storage with fallback, workflow CRUD, state persistence.
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

export async function sessionStorageGet(key) {
  if (HAS_NATIVE_SESSION_STORAGE) {
    return await _browser.storage.session.get(key);
  }
  const fallbackKey = toSessionFallbackKey(key);
  const fallback = await _browser.storage.local.get(fallbackKey);
  return { [key]: fallback[fallbackKey] };
}

export async function sessionStorageSet(values) {
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

export async function clearSessionFallbackOnStartup() {
  if (HAS_NATIVE_SESSION_STORAGE) return;

  const allLocal = await _browser.storage.local.get(null);
  const staleSessionKeys = Object.keys(allLocal || {}).filter((key) =>
    key.startsWith(SESSION_STORAGE_PREFIX)
  );
  if (staleSessionKeys.length > 0) {
    await _browser.storage.local.remove(staleSessionKeys);
  }
}

// ── Workflow CRUD ──────────────────────────────────────────────────

export async function saveWorkflow(workflow) {
  const result = await _browser.storage.local.get('workflows');
  const workflows = result.workflows || {};
  workflows[workflow.id] = workflow;
  await _browser.storage.local.set({ workflows });
}

export async function loadWorkflow(id) {
  const result = await _browser.storage.local.get('workflows');
  return result.workflows?.[id] ?? null;
}

export async function getAllWorkflows() {
  const result = await _browser.storage.local.get('workflows');
  const workflows = result.workflows || {};
  return Object.values(workflows).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteWorkflow(id) {
  const result = await _browser.storage.local.get('workflows');
  const workflows = result.workflows || {};
  delete workflows[id];
  await _browser.storage.local.set({ workflows });
}

// ── State Persistence ─────────────────────────────────────────────

export async function persistState(state) {
  await sessionStorageSet({ triggerState: state });
}

export async function restoreState(defaultState) {
  const result = await sessionStorageGet('triggerState');
  if (result.triggerState) {
    return {
      ...defaultState,
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
  }
  return defaultState;
}

// ── Backend URL ───────────────────────────────────────────────────

let backendUrlCache = null;

export async function getBackendBaseUrl() {
  if (backendUrlCache) {
    return backendUrlCache;
  }
  const { sanitizeUrl } = await import('../../shared/config.js');
  const result = await _browser.storage.sync.get('backendUrl');
  const configured = sanitizeUrl(result.backendUrl);
  backendUrlCache = configured || null;
  return backendUrlCache;
}

export function setBackendUrlCache(url) {
  backendUrlCache = url;
}

// ── Debug Logging ─────────────────────────────────────────────────

export async function logReplayFailure(entry) {
  const result = await _browser.storage.local.get('replayDebugLogs');
  const logs = Array.isArray(result.replayDebugLogs) ? result.replayDebugLogs : [];
  logs.push(entry);
  const capped = logs.slice(-200);
  await _browser.storage.local.set({ replayDebugLogs: capped });
}
```

- [ ] **Step 2: Update `src/extension/background/service-worker.js` to import from storage.js**

Add import:
```js
import {
  sessionStorageGet,
  clearSessionFallbackOnStartup,
  saveWorkflow,
  loadWorkflow,
  getAllWorkflows,
  deleteWorkflow,
  persistState as persistStateToStorage,
  restoreState as restoreStateFromStorage,
  getBackendBaseUrl,
  setBackendUrlCache,
  logReplayFailure,
} from './storage.js';
```

Remove the corresponding function definitions and constants from service-worker.js:
- `SESSION_STORAGE_PREFIX`, `HAS_NATIVE_SESSION_STORAGE`
- `toSessionFallbackKey`, `sessionStorageGet`, `sessionStorageSet`
- `clearSessionFallbackOnStartup`
- `saveWorkflow`, `loadWorkflow`, `getAllWorkflows`, `deleteWorkflow`
- The inline `persistState` and `restoreState` (replace with calls to the imported versions)
- `getBackendBaseUrl`, `backendUrlCache`
- `logReplayFailure`

Update `persistState()` calls to `persistStateToStorage(state)` and `restoreState()` calls to use `restoreStateFromStorage(state)` which returns the restored state.

- [ ] **Step 3: Run tests**

```bash
npm test
```

- [ ] **Step 4: Run build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/extension/background/storage.js src/extension/background/service-worker.js
git commit -m "extract storage module from service worker"
```

---

## Task 9: Extract `src/extension/background/upload-queue.js`

**Files:**
- Create: `src/extension/background/upload-queue.js`
- Modify: `src/extension/background/service-worker.js`

- [ ] **Step 1: Create `src/extension/background/upload-queue.js`**

```js
/**
 * Trigger - Upload Retry Queue
 * Exponential backoff queue for backend upload failures.
 */

import { UPLOAD_QUEUE_KEY, UPLOAD_MAX_RETRIES, UPLOAD_INITIAL_BACKOFF_MS } from '../../shared/constants.js';
import { getBackendBaseUrl } from './storage.js';

const _browser = typeof browser !== 'undefined' ? browser : chrome;

let uploadRetryTimer = null;

export function computeUploadBackoffMs(attempt) {
  return UPLOAD_INITIAL_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
}

export async function getUploadRetryQueue() {
  const result = await _browser.storage.local.get(UPLOAD_QUEUE_KEY);
  return Array.isArray(result[UPLOAD_QUEUE_KEY]) ? result[UPLOAD_QUEUE_KEY] : [];
}

export async function setUploadRetryQueue(queue) {
  await _browser.storage.local.set({ [UPLOAD_QUEUE_KEY]: queue });
}

export async function uploadWorkflowRemote(workflow) {
  const apiBaseUrl = await getBackendBaseUrl();
  if (!apiBaseUrl) {
    throw new Error('backend URL not configured');
  }

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

export async function enqueueUploadRetry(workflow, reason) {
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

export function scheduleUploadRetryWorker(delayMs = 0) {
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

export async function processUploadRetryQueue() {
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
```

- [ ] **Step 2: Update service-worker.js**

Add import:
```js
import {
  uploadWorkflowRemote,
  enqueueUploadRetry,
  processUploadRetryQueue,
} from './upload-queue.js';
```

Remove the corresponding functions from service-worker.js.

- [ ] **Step 3: Run tests and build**

```bash
npm test && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/extension/background/upload-queue.js src/extension/background/service-worker.js
git commit -m "extract upload-queue module from service worker"
```

---

## Task 10: Extract `src/extension/background/recording.js`

**Files:**
- Create: `src/extension/background/recording.js`
- Modify: `src/extension/background/service-worker.js`

- [ ] **Step 1: Create `src/extension/background/recording.js`**

```js
/**
 * Trigger - Recording Handlers
 * START_RECORDING, STOP_RECORDING, RECORD_STEP message handlers.
 */

import { saveWorkflow, persistState as persistStateToStorage } from './storage.js';
import { uploadWorkflowRemote, enqueueUploadRetry } from './upload-queue.js';

const _browser = typeof browser !== 'undefined' ? browser : chrome;

export function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  for (const byte of array) {
    id += chars[byte % chars.length];
  }
  return id;
}

export function createRecordingHandlers(getState, setState, startKeepalive, stopKeepalive) {
  return {
    'START_RECORDING': async (msg, sender) => {
      const state = getState();
      state.mode = 'recording';
      state.activeTabId = sender.tab?.id ?? msg.tabId;
      state.steps = [];
      state.workflowId = generateId();
      state.replaySessionStatus = 'idle';
      startKeepalive();
      await persistStateToStorage(state);

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
      const state = getState();
      console.log('[Trigger] Stopping recording. Recorded', state.steps.length, 'steps');
      const workflow = {
        id: state.workflowId,
        name: `Workflow ${new Date().toLocaleString()}`,
        startUrl: state.steps[0]?.url ?? '',
        steps: state.steps,
        createdAt: Date.now(),
      };

      console.log('[Trigger] Saving workflow:', workflow);
      await saveWorkflow(workflow);

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

      const tabId = state.activeTabId;

      state.mode = 'idle';
      state.activeTabId = null;
      state.replaySessionStatus = 'idle';
      stopKeepalive();
      await persistStateToStorage(state);

      if (tabId) {
        _browser.tabs.sendMessage(tabId, {
          type: 'RECORDER_STOP',
        }).catch(() => {});
      }

      return { status: 'stopped', workflow };
    },

    'RECORD_STEP': async (msg, sender) => {
      const state = getState();
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
      await persistStateToStorage(state);

      return { status: 'recorded', index: step.index };
    },
  };
}
```

- [ ] **Step 2: Update service-worker.js**

Add import:
```js
import { generateId, createRecordingHandlers } from './recording.js';
```

Replace the recording handlers in `messageHandlers` with a spread:
```js
const recordingHandlers = createRecordingHandlers(
  () => state,
  (s) => { state = s; },
  startKeepalive,
  stopKeepalive
);
```

Then in the `messageHandlers` object, replace the `START_RECORDING`, `STOP_RECORDING`, and `RECORD_STEP` entries with:
```js
...recordingHandlers,
```

Remove the `generateId` function from service-worker.js (it's now in recording.js).

- [ ] **Step 3: Run tests and build**

```bash
npm test && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/extension/background/recording.js src/extension/background/service-worker.js
git commit -m "extract recording module from service worker"
```

---

## Task 11: Extract `src/extension/background/replay-state.js`

**Files:**
- Create: `src/extension/background/replay-state.js`
- Modify: `src/extension/background/service-worker.js`

This is the largest extraction. It contains the replay state machine, credential handling, freshness checks, and recovery logic.

- [ ] **Step 1: Create `src/extension/background/replay-state.js`**

```js
/**
 * Trigger - Replay State Machine
 * Manages replay orchestration, recovery, credentials, and freshness.
 */

import { MAX_RECOVERY_ATTEMPTS, MAX_STEP_RETRIES, REPLAY_FRESHNESS_THRESHOLD } from '../../shared/constants.js';
import { validateReplayWorkflow, buildReplayFreshnessSample, classifyFailure, isRetryableFailure } from '../../shared/workflow-schema.js';
import { sanitizeUrl } from '../../shared/config.js';
import { persistState as persistStateToStorage, loadWorkflow, logReplayFailure, setBackendUrlCache } from './storage.js';

const _browser = typeof browser !== 'undefined' ? browser : chrome;

// ── Credential Helpers ────────────────────────────────────────────

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
      promptsByKey[key] = { key, label, stepIndices: [stepIndex] };
    } else {
      promptsByKey[key].stepIndices.push(stepIndex);
    }
  }

  return {
    prompts: Object.values(promptsByKey),
    sensitiveStepKeys,
  };
}

// ── Step Helpers ──────────────────────────────────────────────────

function getStepStableIndex(step, fallbackIndex) {
  if (step && typeof step.index === 'number') return step.index;
  return fallbackIndex;
}

function prepareStepForExecution(step, index, sensitiveStepKeys) {
  if (!step) return step;
  const stepIndex = getStepStableIndex(step, index);
  const credentialKey = sensitiveStepKeys[stepIndex];
  if (!credentialKey) return step;
  return { ...step, _credentialKey: credentialKey };
}

function getReplayResponseForCurrentIndex(state) {
  const step = state.steps[state.replayIndex];
  if (!step) {
    return { type: 'REPLAY_COMPLETE' };
  }
  return {
    type: 'EXECUTE_STEP',
    step: prepareStepForExecution(step, state.replayIndex, state.sensitiveStepKeys),
    index: state.replayIndex,
    total: state.steps.length,
  };
}

async function getReplayResponseForCompletedIndex(state, index, stopKeepalive) {
  state.replayIndex = index + 1;
  state.lastReplayProgressAt = Date.now();
  state.lastReplayHeartbeatAt = Date.now();
  state.recoveryAttempts = 0;
  state.replaySessionStatus = 'active';
  delete state.stepRetries[index];
  await persistStateToStorage(state);

  if (state.replayIndex >= state.steps.length) {
    state.mode = 'idle';
    state.replaySessionStatus = 'completed';
    stopKeepalive();
    await persistStateToStorage(state);
    return { type: 'REPLAY_COMPLETE' };
  }

  const nextStep = state.steps[state.replayIndex];
  if (nextStep.type === 'navigate') {
    await _browser.tabs.update(state.activeTabId, { url: nextStep.url });
    return { type: 'WAITING_NAVIGATION' };
  }

  return {
    type: 'EXECUTE_STEP',
    step: prepareStepForExecution(nextStep, state.replayIndex, state.sensitiveStepKeys),
    index: state.replayIndex,
    total: state.steps.length,
  };
}

// ── Abort / Recovery ──────────────────────────────────────────────

async function abortReplaySession(state, reasonType, reason, stopKeepalive) {
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
  stopKeepalive();
  await persistStateToStorage(state);
}

// ── Public: Create Handlers ───────────────────────────────────────

export function createReplayHandlers(getState, startKeepalive, stopKeepalive, getReplayFreshnessCheck) {
  const generateId = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    for (const byte of array) {
      id += chars[byte % chars.length];
    }
    return id;
  };

  return {
    'START_REPLAY': async (msg) => {
      const state = getState();
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
      const freshnessCheck = getReplayFreshnessCheck();
      freshnessCheck.sampleSteps = buildReplayFreshnessSample(workflow.steps);
      freshnessCheck.pending = freshnessCheck.sampleSteps.length > 0;
      state.replaySessionStatus = 'active';
      state.stepRetries = {};
      state.lastReplayHeartbeatAt = Date.now();
      state.lastReplayProgressAt = Date.now();
      state.recoveryAttempts = 0;
      startKeepalive();
      await persistStateToStorage(state);

      const tab = await _browser.tabs.create({ url: workflow.startUrl });
      state.activeTabId = tab.id;
      await persistStateToStorage(state);

      return { status: 'replaying', totalSteps: workflow.steps.length };
    },

    'START_REPLAY_INLINE': async (msg, sender) => {
      const state = getState();
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
      const freshnessCheck = getReplayFreshnessCheck();
      freshnessCheck.sampleSteps = buildReplayFreshnessSample(workflow.steps);
      freshnessCheck.pending = freshnessCheck.sampleSteps.length > 0;
      state.replaySessionStatus = 'active';
      state.stepRetries = {};
      state.activeTabId = sender.tab.id;
      state.lastReplayHeartbeatAt = Date.now();
      state.lastReplayProgressAt = Date.now();
      state.recoveryAttempts = 0;
      startKeepalive();
      await persistStateToStorage(state);

      if (workflow.startUrl && sender.tab.url !== workflow.startUrl) {
        await _browser.tabs.update(sender.tab.id, { url: workflow.startUrl });
        return { type: 'WAITING_NAVIGATION' };
      }

      if (!state.credentialsReady) {
        return { type: 'REQUEST_CREDENTIALS', prompts: state.credentialPrompts };
      }

      const firstStep = state.steps[0];
      if (!firstStep) return { type: 'REPLAY_COMPLETE' };
      return {
        type: 'EXECUTE_STEP',
        step: prepareStepForExecution(firstStep, 0, state.sensitiveStepKeys),
        index: 0,
        total: state.steps.length,
      };
    },

    'REPLAY_READY': async (msg, sender) => {
      const state = getState();
      if (state.mode !== 'replaying') return { error: 'not replaying' };
      if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

      state.lastReplayHeartbeatAt = Date.now();
      state.recoveryAttempts = 0;
      state.replaySessionStatus = 'active';
      await persistStateToStorage(state);

      if (!state.credentialsReady && state.credentialPrompts.length > 0) {
        state.replaySessionStatus = 'awaiting_user';
        await persistStateToStorage(state);
        return { type: 'REQUEST_CREDENTIALS', prompts: state.credentialPrompts };
      }

      const freshnessCheck = getReplayFreshnessCheck();
      if (freshnessCheck.pending) {
        state.replaySessionStatus = 'awaiting_user';
        await persistStateToStorage(state);
        return {
          type: 'CHECK_DOM_DRIFT',
          sampleSteps: freshnessCheck.sampleSteps,
          threshold: REPLAY_FRESHNESS_THRESHOLD,
        };
      }

      return getReplayResponseForCurrentIndex(state);
    },

    'DOM_DRIFT_DECISION': async (msg, sender) => {
      const state = getState();
      if (state.mode !== 'replaying') return { error: 'not replaying' };
      if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

      const freshnessCheck = getReplayFreshnessCheck();
      freshnessCheck.pending = false;

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
        await persistStateToStorage(state);
        return { status: 'aborted' };
      }

      state.replaySessionStatus = 'active';
      await persistStateToStorage(state);
      return getReplayResponseForCurrentIndex(state);
    },

    'SUBMIT_REPLAY_CREDENTIALS': async (msg, sender) => {
      const state = getState();
      if (state.mode !== 'replaying') return { error: 'not replaying' };
      if (sender.tab?.id !== state.activeTabId) return { error: 'wrong tab' };

      state.credentialsReady = true;
      state.replaySessionStatus = 'active';
      state.lastReplayHeartbeatAt = Date.now();
      await persistStateToStorage(state);

      return getReplayResponseForCurrentIndex(state);
    },

    'STEP_COMPLETED': async (msg) => {
      const state = getState();
      if (state.mode !== 'replaying') return { error: 'not replaying' };
      return await getReplayResponseForCompletedIndex(state, msg.index, stopKeepalive);
    },

    'STOP_REPLAY': async () => {
      const state = getState();
      if (state.activeTabId) {
        _browser.tabs.sendMessage(state.activeTabId, { type: 'REPLAY_ABORT' }).catch(() => {});
      }
      state.mode = 'idle';
      state.replaySessionStatus = 'aborted';
      state.replayIndex = 0;
      state.lastReplayHeartbeatAt = 0;
      state.lastReplayProgressAt = 0;
      stopKeepalive();
      await persistStateToStorage(state);
      return { status: 'stopped' };
    },

    'STEP_FAILED': async (msg) => {
      const state = getState();
      if (state.mode !== 'replaying') return { error: 'not replaying' };

      const index = typeof msg.index === 'number' ? msg.index : state.replayIndex;
      const reasonType = classifyFailure(msg.reason, msg.reasonType);
      const retries = state.stepRetries[index] || 0;
      const maxRetries = state.maxStepRetries || MAX_STEP_RETRIES;
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
        await persistStateToStorage(state);

        const step = state.steps[index];
        return {
          type: 'EXECUTE_STEP',
          step,
          index,
          total: state.steps.length,
          retry: { attempt: state.stepRetries[index], maxRetries, reasonType },
        };
      }

      state.replaySessionStatus = 'awaiting_user';
      await persistStateToStorage(state);

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
      const state = getState();
      if (state.mode !== 'replaying') return { error: 'not replaying' };
      if (sender.tab?.id && sender.tab.id !== state.activeTabId) return { error: 'wrong tab' };

      const index = typeof msg.index === 'number' ? msg.index : state.replayIndex;
      const action = msg.action;

      if (action === 'retry') {
        const step = state.steps[index];
        state.replaySessionStatus = 'active';
        state.lastReplayHeartbeatAt = Date.now();
        await persistStateToStorage(state);

        if (state.activeTabId) {
          await _browser.tabs.sendMessage(state.activeTabId, {
            type: 'EXECUTE_STEP',
            step: prepareStepForExecution(step, index, state.sensitiveStepKeys),
            index,
            total: state.steps.length,
          });
        }
        return { status: 'retrying', index };
      }

      if (action === 'skip' || action === 'mark_fixed') {
        const response = await getReplayResponseForCompletedIndex(state, index, stopKeepalive);
        if (state.activeTabId) {
          await _browser.tabs.sendMessage(state.activeTabId, response);
        }
        return { status: action === 'skip' ? 'skipped' : 'marked_fixed', index, responseType: response.type };
      }

      return { error: 'unknown assist action' };
    },

    'REPLAY_HEARTBEAT': async (msg, sender) => {
      const state = getState();
      if (state.mode !== 'replaying') return { ok: false, reason: 'not replaying' };
      if (sender.tab?.id !== state.activeTabId) return { ok: false, reason: 'wrong tab' };
      state.lastReplayHeartbeatAt = Date.now();
      state.replaySessionStatus = 'active';
      state.recoveryAttempts = 0;
      await persistStateToStorage(state);
      return { ok: true, index: state.replayIndex };
    },

    'SET_BACKEND_URL': async (msg) => {
      const sanitized = sanitizeUrl(msg.backendUrl);
      if (!sanitized) {
        return { error: 'invalid backend URL' };
      }
      setBackendUrlCache(sanitized);
      await _browser.storage.sync.set({ backendUrl: sanitized });
      return { status: 'ok', backendUrl: sanitized };
    },
  };
}

export { abortReplaySession, buildCredentialMetadata };
```

- [ ] **Step 2: Update service-worker.js to use createReplayHandlers**

Add import:
```js
import { createReplayHandlers, abortReplaySession } from './replay-state.js';
```

Create the handlers:
```js
const replayHandlers = createReplayHandlers(
  () => state,
  startKeepalive,
  stopKeepalive,
  () => replayFreshnessCheck
);
```

In the `messageHandlers` object, replace all replay-related entries with:
```js
...replayHandlers,
```

Remove the corresponding function definitions from service-worker.js.

The service-worker.js should now contain only:
- State definition
- Keepalive management
- Message router
- `initializeBackgroundState`
- Tab listeners (`onUpdated`, `onRemoved`)
- `GET_STATE`, `GET_WORKFLOWS`, `DELETE_WORKFLOW`, `EXTENSION_PING` handlers

- [ ] **Step 3: Run tests and build**

```bash
npm test && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/extension/background/replay-state.js src/extension/background/service-worker.js
git commit -m "extract replay-state module from service worker"
```

---

## Task 12: Verify final service worker is under 200 lines

**Files:**
- Review: `src/extension/background/service-worker.js`

- [ ] **Step 1: Count lines**

```bash
wc -l src/extension/background/service-worker.js
```

Expected: under 200 lines. The file should contain:
- Imports
- State definition
- Keepalive functions
- Message router (dispatch table merging recording + replay handlers)
- `initializeBackgroundState`
- `GET_STATE`, `GET_WORKFLOWS`, `DELETE_WORKFLOW`, `EXTENSION_PING` handlers
- Tab event listeners

- [ ] **Step 2: Run full test suite**

```bash
npm run test:all
```

Expected: all extension, recovery, smoke, viewer, and backend tests pass.

- [ ] **Step 3: Run build and verify output**

```bash
npm run build
ls -la dist/extension/content/content.js dist/extension/background/service-worker.js dist/extension/popup/popup.js dist/extension/manifest.json
```

Expected: all output files exist and are non-empty.

- [ ] **Step 4: Verify manifest content**

```bash
cat dist/extension/manifest.json | grep -A 3 content_scripts
```

Expected: content_scripts references `content/content.js` (single bundle).

- [ ] **Step 5: Commit if any cleanup was needed**

```bash
git add -A src/extension/background/
git commit -m "finalize service worker decomposition"
```

---

## Task 13: Update README with build instructions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Quick Start section**

In the README, after "Select the `extension/` folder", change to:

Find:
```
4. Click **Load unpacked**
5. Select the `extension/` folder
```

Replace with:
```
4. Run `npm install && npm run build`
5. Click **Load unpacked**
6. Select the `dist/extension/` folder
```

- [ ] **Step 2: Add Development section after Quick Start**

Add after the Quick Start section:

```markdown
### Development

```bash
# Install dependencies
npm install

# Build once
npm run build

# Watch mode (rebuilds on file change)
npm run dev

# Run tests
npm test

# Run all tests (extension + viewer + backend)
npm run test:all
```

Source lives in `src/`, builds to `dist/`. Load `dist/extension/` as your unpacked extension in Chrome.
```

- [ ] **Step 3: Update File Structure section**

Update the file structure diagram to reflect the new `src/` layout.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "update README with build instructions"
```

---

## Task 14: End-to-end verification

- [ ] **Step 1: Clean build**

```bash
rm -rf dist && npm run build
```

- [ ] **Step 2: Verify all tests pass**

```bash
npm run test:all
```

- [ ] **Step 3: Verify extension loads**

Load `dist/extension/` as an unpacked extension in Chrome. Confirm:
1. Extension icon appears
2. Popup opens and shows "Ready"
3. Record a simple click workflow on any page
4. Stop recording - workflow appears in popup list
5. Replay the workflow - ghost cursor moves, steps execute
6. Share button works (copies link or shows notice)

- [ ] **Step 4: Verify no file in `src/` exceeds 300 lines**

```bash
find src -name '*.js' -exec wc -l {} + | sort -rn | head -20
```

Expected: all files under 300 lines.

- [ ] **Step 5: Final commit if needed**

```bash
git add -A
git commit -m "architecture foundation: esbuild pipeline and module restructure complete"
```
