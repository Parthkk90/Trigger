# Trigger Phase 2+ Master Change Log

## Scope
This document tracks all roadmap changes from Phase 2 onward, including:

- implemented work
- partially implemented work
- pending roadmap items

Date recorded: 2026-04-04

## Status Legend

- Implemented: shipped in code and covered by existing tests
- Partial: started in code but not fully at roadmap target
- Pending: listed in roadmap, not implemented in this cycle

## Phase 2: Replay Intelligence Upgrade

### Implemented

1. Screenshot anchors and assist context
- Recorder can attach screenshot anchors to steps with timeout-safe capture.
- Assist panel can render the anchor image for recovery context.
- Files:
	- extension/content/recorder.js
	- extension/content/overlay.js
	- tests/run-tests.js

2. DOM drift detection gate before replay
- Pre-execution confidence sampling was added.
- Replay now requests proceed/cancel when drift risk is high.
- Drift warning dialog was added in overlay.
- Files:
	- extension/background/service-worker.js
	- extension/content/injector.js
	- extension/content/replay.js
	- extension/content/overlay.js
	- tests/run-tests.js

3. Credential parameterization (auth wall strategy)
- Sensitive input steps now map to runtime credential prompts.
- Credentials remain in-memory only and are injected just-in-time.
- Files:
	- extension/background/service-worker.js
	- extension/content/injector.js
	- extension/content/overlay.js
	- tests/run-tests.js

4. CAPTCHA human-in-the-loop pause
- Replay detects CAPTCHA signatures and pauses via assist flow.
- Failure is typed to captcha_challenge for deterministic recovery.
- Files:
	- extension/content/replay.js
	- extension/background/service-worker.js
	- tests/run-tests.js

5. DOM-shift aware recorder fallback
- Recorder can switch to MutationObserver path on hostile sites.
- Hostility heuristic includes known hosts and class-name entropy.
- Files:
	- extension/content/recorder.js
	- IMPLEMENTATION_ROADMAP.md

### Partial

1. Workflow versioning with content-hash fingerprinting
- Drift checks exist, but full workflow versioning model is not fully complete.

2. Per-step timeout controls and execution profiles
- Foundations exist, but full user-facing controls/profile matrix is not complete.

3. Performance guardrails for SPA-heavy replay
- Targeted warning and threshold framework is not fully implemented end-to-end.

### Pending

1. Cookie passthrough auth strategy
- Credential parameterization is implemented first.
- Cookie export/injection strategy remains pending.

## Phase 3: Sharing, Backend, Multi-Browser, Hostile-Site Unlock

### Implemented

1. Migration runner and backend migration lifecycle
- Added migrate/rollback commands and startup preflight migration run.
- Files:
	- backend/migration-runner.js
	- backend/migrate.js
	- backend/rollback.js
	- backend/package.json
	- backend/server.js

2. Slug retry cap and explicit exhaustion handling
- Added capped retry logic and structured failure response.
- Files:
	- backend/server.js
	- tests/test-backend.js

3. Optional POST auth
- Added optional bearer token check for backend POST routes.
- Files:
	- backend/server.js
	- backend/.env.example
	- backend/README.md
	- tests/test-backend.js

4. Upload retry queue in extension
- Added local retry queue with backoff and persistence handling.
- Files:
	- extension/background/service-worker.js

5. Cloud replay foundation (queue + worker + API)
- Added cloud replay queue service.
- Added enqueue/status backend endpoints.
- Added Playwright worker processor.
- Added viewer integration for cloud replay run + polling.
- Files:
	- backend/cloud-replay.js
	- backend/server.js
	- workers/replay-worker.js
	- viewer/index.html
	- viewer/viewer.js
	- tests/test-backend.js
	- tests/test-viewer.js

6. Multi-browser compatibility groundwork
- Replaced direct chrome usage with runtime wrapper pattern in key extension/viewer files.
- Files:
	- extension/background/service-worker.js
	- extension/content/injector.js
	- extension/content/overlay.js
	- extension/content/recorder.js
	- extension/content/replay.js
	- extension/popup/popup.js
	- viewer/viewer.js

7. CI and smoke path
- Added CI workflow and smoke roundtrip test.
- Files:
	- .github/workflows/ci.yml
	- tests/test-smoke.js
	- package.json

8. Store listing preparation docs
- Added store submission prep document.
- Files:
	- docs/store-listing.md

### Partial

1. Full CDP hostile-site unlock strategy
- Cloud worker foundation exists.
- Full CDP/local bridge architecture for all restricted surfaces is not complete.

2. Firefox/Edge parity guarantees
- Wrapper migration is largely done, but full cross-browser certification matrix is not complete.

### Pending

1. URL-sharing fallback deprecation path completion
2. Optional workflow encryption at rest
3. Full production deploy pipeline beyond current CI test gate

## Phase 4: UI/UX Redesign (Parallel Track)

### Implemented

1. Shared visual tokens
- Added token file and wired popup/overlay usage.
- Files:
	- extension/styles/tokens.css
	- extension/popup/popup.html
	- extension/content/overlay.js

2. Popup home redesign
- Home-first action model and streamlined workflow cards.
- Added last-run metadata formatting and action affordances.
- Files:
	- extension/popup/popup.html
	- extension/popup/popup.js

3. Overlay accessibility and polish
- Dialog semantics, aria labels, focus-visible styling, touch target sizing.
- Files:
	- extension/content/overlay.js
	- tests/run-tests.js

4. Test coverage updates for redesign
- Added assertions for two-click action reachability and overlay ARIA contracts.
- Files:
	- tests/run-tests.js

### Partial

1. Formal WCAG evidence reporting
- Accessibility improvements were implemented.
- Formal contrast audit artifact/report is still optional follow-up.

## Phase 5: Advanced Automation

### Pending

1. Conditional branches and loops
2. Multi-tab orchestration
3. Advanced assertions/reporting
4. Scheduling/webhook trigger model
5. Workflow composition/sub-workflows

## Testing and Validation Snapshot

Latest reported status in this cycle:

- Extension suite: passing
- Recovery suite: passing
- Smoke suite: passing
- Backend suite: passing
- Viewer suite: logical tests passing, run currently wrapped due known polling interval cleanup behavior

## Bottom Line

From Phase 2 onward, work progressed from replay reliability improvements into a broader platform shift:

1. local replay made drift-aware and assist-guided
2. recorder adapted for hostile DOM-shift environments
3. backend evolved from simple sharing into cloud replay capability
4. viewer and UI were upgraded to support both usability and cloud execution

This is not only a Phase 2 implementation log; it is a complete Phase 2+ change status record.
