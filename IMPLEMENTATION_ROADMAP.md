# Trigger Implementation Roadmap

Last updated: 2026-04-04  
Status: Phase 0 complete · Phase 1 active · Phase 4 parallel track active · Phase 5 deferred

Execution updates:
- Completed: Removed hardcoded localhost defaults in share pipeline.
    - Extension backend upload now requires configured backend URL.
    - Popup embedded-link sharing now requires configured viewer URL.
    - Viewer now defaults backend origin to same-origin when hosted.
- Completed: Recorder sensitive input hardening.
    - Redacts password / card / token-like fields even on field-switch flush.
    - Suppresses keypress step capture on sensitive fields.
- Completed: Added viewer unit tests for Phase 1 coverage targets.
    - Covers backend URL resolution, slug loading, and extension replay handoff.
- Completed: Replay fail-state recovery policy foundation.
    - Added typed failure reasons and step retry budget (default 3).
    - Added local structured replay failure logging in browser storage.
- Completed: Keepalive resilience foundation.
    - Added replay heartbeat pings from content script.
    - Added service-worker watchdog with bounded auto-recovery attempts.
- Completed: Security baseline documentation pass.
    - Added permission rationale and security audit notes.
- Completed: CAPTCHA human-in-the-loop replay pause.
    - Replay detects CAPTCHA challenges (reCAPTCHA / hCaptcha / Turnstile heuristics).
    - Replay enters assist mode with typed reason `captcha_challenge` and manual-continue prompt.
    - Added replay unit coverage for CAPTCHA detection path.
- Validation: extension tests (85/85), recovery tests (4/4), and backend tests (24/24) passing.
- Analysis (2026-04-04): Hostile site compatibility audit completed.
    - Categorised five failure modes: Meta SPA DOM aggression, chrome:// page restriction,
      auth walls, strict CSP, and CAPTCHAs.
    - Conclusion: content script architecture is correct for ~80% of the web.
      Remaining 20% (Meta, CSP-hardened, Chrome internals) requires CDP/Playwright layer.
    - Accelerate Phase 3 CDP work; do not change current architecture.
    - Details in "Hostile Site Compatibility Analysis" section below.

---

## Current State Snapshot

### Implemented and Working
- Recording pipeline: click / input / select / checkbox / keypress / navigation capture with fingerprinting.
- Replay pipeline: confidence-based execution, ghost cursor, step orchestration, assisted mode entry.
- Storage and state: workflow persistence in `chrome.storage.local`, runtime state in `chrome.storage.session`.
- Popup workflow management: record / stop / play / share / export / delete.
- Viewer app: URL workflow parsing, slug loading, extension detection, replay handoff.
- Backend API: workflow create / read, slug links, resolver page, rate limiting.
- Tests: extension suite (79 pass) + backend suite (24 pass).

### Confirmed Gaps and Risk Register

| # | Gap | Severity | Addressed in |
|---|-----|----------|--------------|
| G1 | Hardcoded `localhost` defaults in popup/viewer | High | Phase 1 ✓ |
| G2 | Assisted-mode retry lacks richer recovery UX | Medium | Phase 2 |
| G3 | No viewer test suite | Medium | Phase 1 ✓ |
| G4 | No offline retry queue for remote upload failures | Medium | Phase 3 |
| G5 | Keepalive strategy unvalidated for long workflows / browser idle | High | Phase 1 ✓ |
| G6 | No workflow versioning - DOM drift breaks recorded workflows silently | High | Phase 2 |
| G7 | No multi-browser support (Chrome-only APIs used throughout) | Medium | Phase 3 |
| G8 | No CI/CD pipeline or deployment strategy | High | Phase 3 |
| G9 | No performance / memory budgets for extension on SPA-heavy sites | Medium | Phase 2 |
| G10 | Security model too thin - keypress capture, no content script XSS isolation | High | Phase 1 ✓ |
| G11 | Rate limiting is IP-only; no auth for private deployments | Medium | Phase 3 |
| G12 | No Chrome Web Store submission plan (review cycles, update distribution) | Medium | Phase 3 |
| G13 | No deprecation path for URL-based sharing fallback | Low | Phase 3 |
| G14 | Stitch asset references are opaque internal IDs with no registry note | Low | Phase 4 |
| G15 | Exit criteria are qualitative with no measurable targets | Medium | All phases |
| G16 | Meta/SPA sites patch addEventListener - event-listener recorder goes blind | High | Phase 3 |
| G17 | chrome:// pages inaccessible to content scripts - architectural ceiling | High | Phase 3 (CDP) |
| G18 | Auth walls not handled - session state not preserved across replay sessions | Medium | Phase 2/4 |
| G19 | Strict CSP blocks injected scripts - content script replay fails silently | High | Phase 3 (CDP) |
| G20 | No CAPTCHA handling - replay stalls at challenge pages with no recovery path | Medium | Phase 2 ✓ |

---

## Phase Plan

### Phase 0 - Baseline (Complete)
Goal: Working recorder / replayer proof-of-concept with local storage and sharing.

Delivered:
- Core extension architecture (content scripts + service worker + popup).
- Fingerprint generation and resolution scoring.
- Replay execution with confidence thresholds.
- JSON export and URL-based sharing fallback.

Exit criteria met:
- End-to-end record → save → replay works on target sites.

---

### Phase 1 - Reliability Hardening (Active)
Goal: Stabilize runtime behaviour, close security gaps, and remove environment assumptions.

Work items:
- **Config strategy** - replace hardcoded `localhost` URLs. Prefer saved backend URL from `chrome.storage.sync`; fall back to relative origin in viewer when hosted. Expose a config UI in the popup settings panel.
- **Security baseline** - audit content script injection points for XSS vectors. Add CSP headers to the viewer. Mask sensitive field values (password, credit-card, SSN patterns) in the recorded step payload; do not store raw keystrokes for those inputs. Document the full permission set required and remove any over-broad permissions.
- **Keepalive resilience** - validate service worker keepalive under long workflows (> 5 min) and browser idle conditions. Add a heartbeat check with automatic recovery.
- **Replay fail-state recovery policy** - add a retry budget per step (configurable, default 3). Distinguish failure types: selector-not-found, network/navigation timeout, permission error. Log structured failure reasons to local debug storage.
- **Viewer test suite** - add unit tests covering URL parsing, extension detection, and replay handoff flows. Target ≥ 80% branch coverage on viewer logic.
- **Structured error telemetry** - local debug logs only, no external tracking by default; opt-in flag for future remote telemetry.

Exit criteria (measurable):
- Replay success rate on a fixed set of 10 representative workflows ≥ baseline + 15 pp.
- Same build operates without source edits in both local dev and hosted viewer environments.
- Zero raw keystrokes stored for fields matching sensitive-input heuristics.
- Viewer test suite passes with ≥ 80% branch coverage.

---

### Phase 2 - Replay Intelligence Upgrade
Goal: Improve element resolution, introduce workflow versioning, and deliver clear assisted-recovery UX.

Work items:
- **Fallback selector evolution** - attribute-subset probing, role + text blends, proximity scoring when primary selector fails.
- **Workflow versioning** - attach a content-hash fingerprint to each recorded workflow. On replay, detect DOM drift (fingerprint mismatch above a threshold) and prompt the user to re-record or review affected steps rather than failing silently.
- **Screenshot anchor hints** - capture a viewport thumbnail at record time for each step. Surface as context in the assisted panel. Mandatory (not optional) for SPA-heavy sites where DOM fingerprints go stale before replay - Meta properties, React/Next SPAs, and any site with hashed class names require visual anchors as the primary fallback.
- **Improved assisted panel** - explicit "Retry now", "Skip step", and "Mark as fixed" actions with deterministic state transitions. Show target element preview and confidence score inline. Add step context (step N of M, failure reason, last-known screenshot).
- **Per-step timeout controls** - allow individual steps to override the workflow-level timeout. Add an execution profile selector (fast / balanced / slow / manual).
- **Performance guardrails** - instrument memory and CPU usage during replay on SPA-heavy sites. Emit warnings if usage exceeds configurable thresholds. Add a max-step-count guard to prevent runaway workflows.
- **Auth wall handling** *(G18)* - two complementary strategies. (1) Session cookie passthrough: before replay, export session cookies from the recorded tab and inject them into the replay tab via `chrome.cookies`; works for most standard auth flows. (2) Credential parameterization: workflow editor exposes username/password as named parameters filled in before replay; safe given existing sensitive field redaction. Implement (2) first - lower risk and no new permissions required.
- **CAPTCHA handling** *(G20)* - human-in-the-loop path implemented. Replay now detects CAPTCHA iframe/signature heuristics, pauses replay, and surfaces assist-mode guidance to solve manually and continue. API path (2captcha / Anti-Captcha) remains a follow-on item in Phase 4/5.

Exit criteria (measurable):
- Manual intervention rate on the representative workflow set drops ≥ 20% vs Phase 1 baseline.
- DOM drift detected and surfaced to user within 1 replay attempt (no silent failure).
- Assisted panel state machine has 100% test coverage for all action → state transitions.
- A recorded workflow that requires session auth replays successfully via cookie passthrough on a test site.
- Replay pauses and surfaces the assist panel when a CAPTCHA iframe is detected (unit test against mocked iframe).

---

### Phase 3 - Sharing, Backend Productionization, and Multi-Browser
Goal: Harden deployment, close infrastructure gaps, expand browser support, and unlock hostile-site replay via CDP.

Work items:
- **CI/CD pipeline** - automated test run on every PR (extension + backend suites). Staging → production promotion gated on test pass + smoke test. Deployment via Docker compose or equivalent; environment config via `.env` and secrets manager.
- **Migration runner** - add a `db:migrate` command; run automatically on startup with pre-flight schema checks. Include rollback support.
- **Slug generation** - add a max retry cap (default 10) for collision resolution; surface a clear error if exhausted.
- **API auth** - add optional bearer token auth for private deployments. Document the setup path. Rate limiting moves from IP-only to token-keyed when auth is enabled.
- **Optional workflow encryption at rest** - AES-256 for sensitive teams; key managed per-deployment.
- **Remote upload retry queue** - exponential backoff queue in extension service worker for backend upload failures. Persist queue across restarts via `chrome.storage.local`.
- **Multi-browser support** - audit and replace all Chrome-only APIs (`chrome.*`) with `browser.*` (WebExtensions API) where a polyfill or direct equivalent exists. Target Chrome and Firefox as v1; Edge as a follow-on.
- **Chrome Web Store submission** - prepare store listing, screenshots, privacy disclosure, and review checklist. Plan update distribution cadence and emergency hotfix path.
- **URL-sharing fallback deprecation plan** - set a sunset date once hosted backend is stable; add a deprecation banner in the viewer for old-format URLs.
- **CDP/Playwright cloud worker** *(hostile-site unlock)* - replaces content script injection for sites that are inaccessible or unreliable at the content script layer. This single component unblocks three gap categories simultaneously: G16 (Meta/SPA DOM aggression), G17 (chrome:// pages), and G19 (strict CSP). The worker operates at the browser level via CDP, avoiding addEventListener patching and CSP restrictions. Architecture: cloud-hosted Playwright instance receives a replay job from the backend, executes steps, and streams status back to the viewer. On-prem option via local CDP bridge for enterprise deployments.
- **MutationObserver-based recorder fallback** *(G16)* - for Meta and other sites that patch addEventListener, add a MutationObserver path in the recorder that watches DOM mutations directly instead of listening to synthetic events. Activated automatically when the standard event listener recorder detects a hostile environment (heuristic: class name entropy above threshold, or known hostnames). Pairs with XPath + visual position anchors as the fingerprint strategy since hashed class names are meaningless on these sites.

Exit criteria (measurable):
- Backend deploys from CI without manual steps in staging and production environments.
- Hosted share-link generation succeeds for ≥ 99.5% of requests under normal load.
- Extension operates (record + replay) on Chrome ≥ 120 and Firefox ≥ 121 without source changes.
- Upload retry queue recovers all queued items within 5 min of backend restoration after an outage.
- CDP worker successfully replays a representative workflow on a CSP-hardened site without content script injection.
- MutationObserver recorder captures a click and input step on a Meta property in CI (mocked DOM environment).

---

### Phase 4 - UI/UX Redesign  *(Parallel track - can start after Phase 1)*
Goal: Improve extension usability and visual polish while preserving information density.

Work items:
- Implement redesigned popup home and workflow detail UI in `extension/popup/*` per Stitch designs.
- Unify visual system between popup and viewer (shared design tokens, icon set).
- Add clearer confidence-score and sensitive-field masking messaging.
- Improve accessibility: WCAG AA contrast, keyboard navigation, focus management.
- Add inline onboarding tooltips for first-time users.

Stitch design assets *(snapshot 2026-03-28 - verify links before implementation)*:
- Design system: `assets/13934841847066158550` - Trigger Bolt System
- Screen: Popup Home - `projects/3542544243910909008/screens/d3b561133ce9412992c05d5a5b766493`
- Screen: Workflow Detail - `projects/3542544243910909008/screens/222d8892fb634f1fa98e8787504d3d99`

> Note: These are internal Stitch IDs. If the Stitch project is moved or renamed, update the references here and in `docs/design-assets.md`.

Exit criteria (measurable):
- Common flows (record, play, share) complete in ≤ 2 clicks from popup home.
- All interactive elements pass WCAG AA contrast (4.5:1 for normal text).
- No regression in extension test suite after popup refactor.

---

### Phase 5 - Advanced Automation  *(Parallel track - can start after Phase 2)*
Goal: Support larger, more complex, and production-grade workflows.

Work items:
- Conditional branches and loops with configurable predicates (element exists, text equals, URL matches).
- Multi-tab and multi-domain handoff handling.
- Advanced assertions with clear pass / fail reporting.
- Optional scheduled runs (cron expression) or API-triggered runs (webhook endpoint).
- Workflow composition - reference sub-workflows as steps.

Exit criteria (measurable):
- A representative 3-step conditional workflow (branch on element presence) records and replays correctly end-to-end.
- Multi-tab handoff tested across ≥ 3 representative site pairs.

---

## Recommended Immediate Backlog (Top 15)

| # | Item | Phase | Priority |
|---|------|-------|----------|
| 1 | Remove hardcoded localhost assumptions in popup and viewer | 1 | P0 ✓ |
| 2 | Security audit: mask sensitive fields, review content script XSS vectors, trim permissions | 1 | P0 ✓ |
| 3 | Validate keepalive strategy for long runs and browser idle | 1 | P0 ✓ |
| 4 | Add viewer unit tests (≥ 80% branch coverage on URL parsing and extension detection) | 1 | P1 ✓ |
| 5 | Add replay retry budget and typed failure reasons | 1 | P1 ✓ |
| 6 | Add workflow versioning and DOM drift detection | 2 | P1 |
| 7 | Improve assisted panel: "Retry / Skip / Mark fixed" + deterministic state machine | 2 | P1 |
| 8 | Set up CI/CD pipeline with automated test gate | 3 | P1 |
| 9 | Add credential parameterization (auth wall handling, strategy 2) | 2/4 | P1 |
| 10 | Add CAPTCHA human-in-the-loop pause via assist mode | 2 | P1 ✓ |
| 11 | Add migration runner command for backend | 3 | P2 |
| 12 | Add slug generation retry cap | 3 | P2 |
| 13 | Add backend upload retry queue with exponential backoff | 3 | P2 |
| 14 | CDP/Playwright cloud worker (unblocks Meta, CSP, chrome://) | 3 | P1 |
| 15 | Add smoke test: record → share → replay full path | Cross-cutting | P1 |

---

---

## Hostile Site Compatibility Analysis

*Recorded 2026-04-04. Covers the five failure modes identified in the hostile site audit.*

### Summary

The content script architecture is correct and handles ~80% of the web. The remaining 20% - Meta properties, strict-CSP sites, and Chrome internals - requires moving replay execution to CDP level. This is exactly what Phase 3's Playwright worker delivers. Do not change the current architecture; accelerate Phase 3.

### Site Category Breakdown

#### Meta sites (Instagram, Facebook, X/Twitter)

**Root cause:** These SPAs swap the DOM so aggressively that fingerprints go stale within milliseconds. They also patch `addEventListener` to detect and suppress non-human listeners, blinding the event-based recorder entirely.

**Required changes:**
- Recorder: switch from DOM event listeners to a `MutationObserver`-based path that watches the DOM tree directly. Activated automatically via hostname heuristic or class-name entropy detection.
- Fingerprinting: replace CSS selector fingerprints with XPath + visual position anchors as primary strategy. Hashed class names (e.g. `css-abc123`) are meaningless across sessions.
- Screenshot anchors: mandatory, not optional. Visual fallback is the only reliable anchor when the DOM is rebuilt on every interaction.
- Replay: requires the CDP/Playwright worker (Phase 3). Injecting into their sandboxed page context reliably requires operating at the browser level.

**Effort:** Significant. Phase 3 minimum.

#### chrome:// pages

**Root cause:** Chrome's architecture explicitly forbids content script injection into `chrome://` URLs. This is a hard architectural ceiling - no workaround exists within MV3.

**Required path:** Native messaging host - a local binary that Chrome communicates with via `chrome.runtime.connectNative()`, which then controls the browser via CDP directly. Effectively a lightweight local Playwright.

**Effort:** Architecture change. New binary component. Out-of-store distribution complexity. Phase 3+.

#### Auth walls

**Root cause:** Session state is not preserved across replay sessions. The content script has no mechanism to rehydrate auth.

**Two solutions (implement in order):**
1. **Credential parameterization (Phase 2/4, low risk):** workflow editor exposes credentials as named parameters, filled in before replay. Safe - leverages existing sensitive field redaction. No new permissions needed.
2. **Session cookie passthrough (Phase 3):** export session cookies from the recorded tab via `chrome.cookies` and inject them into the replay tab. Works for most standard OAuth and cookie-auth flows.

**Effort:** Medium. No architecture change. Phase 2/4.

#### Strict CSP sites

**Root cause:** CSP headers block injected scripts at the browser level. The content script is injected before the page's CSP applies (via manifest injection), but dynamic script injection during replay will be blocked.

**Required path:** Playwright cloud worker or local CDP bridge - both operate outside the page's CSP enforcement boundary. No content script solution exists.

**Effort:** Requires cloud replay infrastructure. Phase 3 CDP work.

#### CAPTCHAs

**Root cause:** Replay stalls on CAPTCHA challenges with no recovery path.

**Two options:**
1. **Human-in-the-loop pause (Phase 2, implemented):** CAPTCHA iframe/signature heuristics now pause replay and route users into assist mode with "Solve manually then continue" guidance.
2. **API integration (Phase 4/5):** 2captcha / Anti-Captcha API. ~$2 per 1000 solves. Detect CAPTCHA, submit to API, receive token, inject. Covers reCAPTCHA v2 and hCaptcha.

**Effort:** Low for human-in-the-loop. Medium for API path.

### Architecture Conclusion

Three Phase 3 deliverables unlock the blocked 20%:

| Deliverable | Unblocks |
|-------------|---------|
| CDP/Playwright cloud worker | Meta replay, CSP sites, chrome:// pages |
| Screenshot anchors (mandatory) | Meta recording, all SPA-heavy sites |
| Credential parameterization | Auth walls |

---

## Phase Dependency and Parallelism

```
Phase 0 (Done)
    └── Phase 1 (Active)
            ├── Phase 2
            │       └── Phase 5 (parallel, can start after Phase 2)
            └── Phase 3
Phase 4 (parallel, can start after Phase 1)
```

Phases 4 and 5 do not block the core reliability track and should be staffed in parallel where capacity allows.