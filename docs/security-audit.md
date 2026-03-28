# Trigger Security Audit Notes

Last updated: 2026-03-28

## Scope

This audit covers extension runtime permissions, sensitive data handling in recording, replay failure handling, and local telemetry/logging.

## Permissions Review

Current manifest permissions in extension/manifest.json:
- activeTab
- storage
- tabs
- scripting
- host_permissions: <all_urls>

Assessment:
- No unnecessary API permissions beyond current replay/recording architecture.
- <all_urls> is required for user-directed cross-site recording and replay.
- Future hardening option: narrow host permissions to explicit allowlist in enterprise deployments.

## Sensitive Data Handling

Implemented protections:
- Recorder redacts values for sensitive targets: password/card/token/SSN-like fields.
- Recorder suppresses keypress event capture for sensitive fields.
- Sensitive detection uses target metadata and value heuristics.

Known tradeoff:
- Over-redaction may occur on fields with ambiguous labels (security-first behavior).

## Replay Reliability and Safety

Implemented protections:
- Typed replay failure reasons (selector_not_found, navigation_timeout, permission_error, etc.).
- Retry budget per step (default 3) for retryable failures.
- Assist mode fallback once retries are exhausted.
- Replay heartbeat and watchdog-based recovery attempts.

## Local Debug Logging

- Replay failure logs stored locally in chrome.storage.local under replayDebugLogs.
- Logs are capped to the latest 200 entries.
- No external telemetry by default.

## Remaining Risks

1. Content scripts still run on all URLs by design.
2. Some pages with aggressive CSP or anti-automation controls may fail replay even with retries.
3. False positives in sensitive-field heuristics may redact benign inputs.

## Recommended Next Steps

1. Add optional enterprise host-allowlist mode.
2. Add a user-visible debug logs viewer with clear data retention controls.
3. Add automated tests for service-worker recovery branches under simulated tab lifecycle interruptions.
