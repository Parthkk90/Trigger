# Trigger Chrome Web Store Listing Prep

## Short Description
Automate browser workflows: record clicks and inputs, replay reliably with assist mode, and share runs with secure backend links.

## Full Description
Trigger lets teams record browser workflows and replay them with confidence across real websites.

What Trigger does:
- Records user actions like navigation, clicks, text input, select changes, checks, and keypress actions.
- Replays workflows with confidence scoring, retry handling, and assisted recovery when pages change.
- Supports share links backed by a hosted API so workflows can be loaded by slug.
- Provides viewer-based handoff for extension replay, plus local JSON export for portability.

Why Trigger is useful:
- Reduces repetitive manual browser tasks.
- Keeps workflow execution deterministic with clear fail states.
- Helps QA and operations teams reproduce flows quickly.

## Permissions Justification
- activeTab:
  Used to start recording or replay on the currently active tab selected by the user.
- storage:
  Used to store workflows, runtime state, retry queue metadata, and local debug records.
- tabs:
  Used to create replay tabs, update navigation during replay, and coordinate tab lifecycle.
- scripting:
  Used for extension runtime hooks required by MV3 execution model.
- host_permissions (<all_urls>):
  Required because users can record and replay on arbitrary sites they choose.

## Privacy Disclosure
- Trigger does not sell user data.
- Trigger does not include third-party analytics by default.
- Workflow data is stored locally in extension storage unless user-enabled sharing/upload is used.
- Sensitive input handling redacts password/card/token-like fields during recording.
- For backend sharing, workflow payloads are sent only to the configured backend URL.

## Update Cadence Policy
- Normal release cadence: weekly batched updates.
- Patch cadence: out-of-band patch releases for regressions or reliability defects.
- Major changes: documented in release notes with migration notes where needed.

## Emergency Hotfix Path
1. Cut hotfix branch from latest stable tag.
2. Run extension, recovery, smoke, backend, and viewer test suites.
3. Build and submit expedited Chrome Web Store update with clear security/reliability notes.
4. Announce hotfix in release notes and pin rollback plan.
5. If needed, deploy immediate backend mitigation while store review is pending.
