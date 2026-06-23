# Architecture Foundation: esbuild Pipeline & Module Restructure

**Date:** 2026-04-07
**Status:** Approved
**Scope:** Developer experience / structural refactor - no feature changes

---

## Goal

Add an esbuild build pipeline, restructure source into ES modules with shared code, and decompose the 1032-line service worker into focused modules. This is the foundation for all future feature work (replay reliability, cloud replay, UI polish).

## Constraints

- JavaScript only - no TypeScript
- No new frameworks or libraries (except esbuild as a dev dependency)
- No changes to workflow JSON format
- No behavioral changes - recording, replay, and sharing work identically
- No monorepo/workspaces - single package.json
- Solo tool target, structured for eventual public Chrome Web Store release

---

## 1. Project Structure

### Current

```
Trigger/
├── extension/
│   ├── manifest.json
│   ├── background/service-worker.js    (1032 lines, does everything)
│   ├── content/
│   │   ├── fingerprint.js              (290 lines)
│   │   ├── injector.js                 (325 lines)
│   │   ├── overlay.js                  (476 lines)
│   │   ├── recorder.js                 (514 lines)
│   │   └── replay.js                   (438 lines)
│   ├── popup/popup.js                  (324 lines)
│   └── popup/popup.html
├── backend/server.js                   (463 lines)
├── viewer/viewer.js                    (709 lines)
├── workers/replay-worker.js            (227 lines)
└── tests/
```

All content scripts use IIFE + `window.Trigger` global namespace. No imports between files. Service worker declared as `"type": "module"` in manifest but uses no imports.

### Proposed

```
Trigger/
├── src/
│   ├── shared/
│   │   ├── fingerprint.js
│   │   ├── workflow-schema.js
│   │   ├── config.js
│   │   └── constants.js
│   ├── extension/
│   │   ├── content/
│   │   │   ├── index.js           # Entry point (replaces injector.js)
│   │   │   ├── recorder.js
│   │   │   ├── replay.js
│   │   │   └── overlay.js
│   │   ├── background/
│   │   │   ├── service-worker.js  # Entry + message router (~150 lines)
│   │   │   ├── storage.js         # Storage abstraction (~100 lines)
│   │   │   ├── replay-state.js    # Replay state machine (~250 lines)
│   │   │   ├── upload-queue.js    # Retry queue (~100 lines)
│   │   │   └── recording.js       # Recording handlers (~80 lines)
│   │   └── popup/
│   │       ├── popup.js
│   │       └── popup.html
│   ├── backend/
│   │   ├── server.js
│   │   ├── migrate.js
│   │   ├── migration-runner.js
│   │   ├── rollback.js
│   │   └── cloud-replay.js
│   ├── viewer/
│   │   ├── viewer.js
│   │   └── index.html
│   └── workers/
│       └── replay-worker.js
├── dist/                          # Build output (gitignored)
│   ├── extension/                 # Load as unpacked Chrome extension
│   │   ├── manifest.json
│   │   ├── content/content.js     # Single bundled content script
│   │   ├── background/service-worker.js
│   │   ├── popup/popup.js
│   │   ├── popup/popup.html
│   │   ├── icons/
│   │   └── styles/
│   ├── backend/
│   ├── viewer/
│   └── workers/
├── scripts/
│   └── build.js                   # esbuild build config
├── tests/
└── package.json
```

---

## 2. Build System

### Tool: esbuild

Added as a dev dependency. Sub-50ms builds, native ESM support, zero config for JS.

### Build Targets

| Target | Entry | Output | Format | Reason |
|--------|-------|--------|--------|--------|
| Content scripts | `src/extension/content/index.js` | `dist/extension/content/content.js` | IIFE | Chrome injects content scripts as plain scripts |
| Service worker | `src/extension/background/service-worker.js` | `dist/extension/background/service-worker.js` | ESM | Manifest declares `"type": "module"` |
| Popup | `src/extension/popup/popup.js` | `dist/extension/popup/popup.js` | IIFE | Loaded via `<script>` in popup.html |
| Viewer | `src/viewer/viewer.js` | `dist/viewer/viewer.js` | IIFE | Loaded via `<script>` in viewer HTML |
| Backend | `src/backend/server.js` | `dist/backend/server.js` | CJS | Node.js; `pg`, `fastify`, `@fastify/cors`, `nanoid` marked external |
| Worker | `src/workers/replay-worker.js` | `dist/workers/replay-worker.js` | CJS | Node.js; `playwright`, `bullmq` marked external |

### Build Script (`scripts/build.js`)

- 6 parallel `esbuild.build()` calls
- Copies static assets: `manifest.json`, `popup.html`, `viewer/index.html`, `icons/`, `extension/styles/`
- Patches `manifest.json` at build time: replaces the 5-file content script array with single `content/content.js`
- Watch mode: `--watch` flag for development
- No build-time env var injection - config is runtime-resolved (Chrome Web Store safe)

### npm Scripts

```json
{
  "build": "node scripts/build.js",
  "build:watch": "node scripts/build.js --watch",
  "dev": "node scripts/build.js --watch",
  "test": "npm run build && node tests/run-tests.js && node tests/test-recovery.js && node tests/test-smoke.js",
  "test:extension": "npm run build && node tests/run-tests.js",
  "test:viewer": "npm run build && node tests/test-viewer.js",
  "test:backend": "npm run build && node tests/test-backend.js",
  "test:all": "npm run build && npm test && npm run test:viewer && npm run test:backend"
}
```

---

## 3. Service Worker Decomposition

The current 1032-line `service-worker.js` splits into 5 modules:

### `service-worker.js` (~150 lines) - Entry & router

- Imports all handler modules
- `_browser.runtime.onMessage.addListener` with dispatch table
- `initializeBackgroundState()` startup
- Keepalive interval management (`startKeepalive`, `stopKeepalive`)

### `storage.js` (~100 lines) - Storage abstraction

- `sessionStorageGet` / `sessionStorageSet` with native/fallback logic
- `clearSessionFallbackOnStartup`
- `saveWorkflow`, `loadWorkflow`, `deleteWorkflow`, `listWorkflows`
- `persistState`, `restoreState`
- `getBackendUrl`, `sanitizeUrl`

### `replay-state.js` (~250 lines) - Replay state machine

- The `state` object definition and replay orchestration
- Handlers: `START_REPLAY`, `START_REPLAY_INLINE`, `REPLAY_READY`, `STEP_COMPLETED`, `STEP_FAILED`, `DOM_DRIFT_DECISION`, `SUBMIT_REPLAY_CREDENTIALS`, `STOP_REPLAY`
- `maybeRecoverReplay`, `abortReplaySession`
- Credential metadata: `buildCredentialMetadata`, `deriveCredentialKey`, `deriveCredentialLabel`, `normalizeCredentialKey`
- Freshness check: `buildReplayFreshnessSample`, `replayFreshnessCheck` state
- `getReplayResponseForCurrentIndex`, `getReplayResponseForCompletedIndex`, `prepareStepForExecution`

### `upload-queue.js` (~100 lines) - Upload retry queue

- `enqueueUploadRetry`, `processUploadRetryQueue`
- `scheduleUploadRetryWorker`, `computeUploadBackoffMs`
- `getUploadRetryQueue`, `setUploadRetryQueue`
- `uploadWorkflowRemote`

### `recording.js` (~80 lines) - Recording handlers

- Handlers: `START_RECORDING`, `STOP_RECORDING`, `RECORD_STEP`
- Workflow assembly on stop (build workflow object, save, attempt remote upload)
- `generateId`

---

## 4. Shared Modules

### `src/shared/fingerprint.js`

Extracted from the current content script IIFE. Same logic, ES module exports:

**Exports:**
- `generateFingerprint(element)` - used by recorder (extension) and cloud worker
- `resolveFingerprint(fingerprint)` - used by replay (extension) and cloud worker
- `scoreCandidateMatch(element, fp)` - used internally + freshness evaluation

**Private (not exported):**
- `gatherCandidates`, `getVisibleText`, `inferRole`, `buildUniqueSelector`, `getXPath`, `isElementVisible`, `isGeneratedClass`

Content script's `index.js` imports these and assigns to `window.Trigger.*` during transition (step 3 of migration), then removes the global in step 5.

### `src/shared/workflow-schema.js`

Currently scattered across service-worker.js and viewer.js:

**Exports:**
- `validateReplayWorkflow(workflow)` - from service-worker.js ~line 279
- `buildReplayFreshnessSample(steps)` - from service-worker.js ~line 295
- `classifyFailure(reason, reasonType)` - from service-worker.js ~line 305
- `isRetryableFailure(reasonType)` - from service-worker.js ~line 318
- Step type constants: `STEP_TYPES = ['click', 'input', 'select', 'check', 'keypress', 'navigate']`

### `src/shared/constants.js`

Values currently hardcoded in multiple files:

```js
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
```

### `src/shared/config.js`

Runtime config with environment-aware getters:

```js
export async function getBackendUrl(context) {
  // 'extension': reads from chrome.storage.sync
  // 'viewer': same-origin fallback
  // 'backend' | 'worker': process.env.BACKEND_URL
}
```

No build-time env var injection. Config is always resolved at runtime.

---

## 5. Migration Strategy

Six incremental steps. Each is independently verifiable: load extension, run tests.

### Step 1-2: Add build pipeline + move source (one commit)

1. `npm install --save-dev esbuild`
2. Create `scripts/build.js` with 6 build targets + asset copy
3. Move all source files to `src/` (straight copy, no code changes)
4. Update build script entry points
5. Verify: `npm run build` produces `dist/`, extension loads from `dist/extension/`, all tests pass

### Step 3: Extract shared modules (one commit per module)

1. Create `src/shared/constants.js` - extract hardcoded values, import in all files
2. Create `src/shared/workflow-schema.js` - extract validation + classification
3. Create `src/shared/fingerprint.js` - extract from IIFE, content `index.js` bridges to `window.Trigger.*`
4. Create `src/shared/config.js` - extract backend URL resolution
5. Verify: all tests pass, extension loads, behavior unchanged

### Step 4: Decompose service worker (one commit per module)

1. Extract `storage.js` from service-worker.js
2. Extract `upload-queue.js`
3. Extract `recording.js`
4. Extract `replay-state.js`
5. Service-worker.js becomes entry point + router
6. Verify: all tests pass after each extraction

### Step 5: Remove `window.Trigger` global (one commit)

1. Content scripts use direct imports (esbuild bundles into single IIFE)
2. Remove all `window.Trigger = window.Trigger || {}` assignments
3. Remove bridge assignments in `index.js`
4. Update tests to import functions directly instead of mocking `window.Trigger`
5. Verify: all tests pass, extension loads

### Step 6: Update manifest + cleanup (one commit)

1. Build script generates patched `manifest.json` pointing at `content/content.js`
2. Remove old `extension/` source directory (now lives in `src/extension/`)
3. Add `dist/` to `.gitignore`
4. Update README with new build instructions
5. Verify: full end-to-end - build, load extension, record, replay, share, tests

### Risk mitigation

- Each step is a single revertable commit
- Step 3 uses a `window.Trigger` bridge so content scripts work during transition
- No big-bang switchover - the extension works at every intermediate state
- If any step breaks, it's a single file move or import change to revert

---

## 6. Test Impact

- Tests currently import source files directly using `require` with jsdom
- After migration: tests import from `src/` for fast iteration
- CI command: `npm run build && npm test` runs against `dist/`
- No test framework change - jsdom + custom runner stays
- The `window.Trigger` mocking pattern in tests works until step 5, then tests import functions directly
- Test file paths update once (step 2) when source moves to `src/`

---

## 7. Out of Scope

- TypeScript conversion
- Monorepo / npm workspaces
- UI framework for popup or viewer
- CSS preprocessing
- Linting / formatting setup
- Test framework migration
- Backend restructuring (already has separate server.js and replay-worker.js entry points)
- New features of any kind
- Workflow JSON format changes

---

## 8. Success Criteria

1. `npm run build` completes in under 500ms
2. `npm run build:watch` rebuilds on file change in under 100ms
3. Extension loads from `dist/extension/` and passes all existing tests
4. No file in `src/` exceeds 300 lines
5. `src/shared/fingerprint.js` is imported by both extension content scripts and cloud worker
6. Service worker entry point (`src/extension/background/service-worker.js`) is under 200 lines
7. Zero behavioral regressions - record, replay, share, export all work identically

