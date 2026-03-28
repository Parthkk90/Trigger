# Trigger — Workflow Recorder & Replay Extension

Record user interactions on any website and replay them automatically. Share workflows with others as executable links.

## 🚀 Quick Start

### Install the Extension

1. Clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `extension/` folder
6. The Trigger icon (⚡) should appear in your toolbar

### Record a Workflow

1. Navigate to any website
2. Click the Trigger extension icon
3. Click **Record** (the popup closes)
4. Interact with the page:
   - Click buttons
   - Fill in forms
   - Navigate between pages
   - Press Enter to submit forms
5. Click the extension icon again
6. Click **Stop** to save the workflow
7. Give it a name (auto-generated as "Workflow [timestamp]")

### Replay a Workflow

1. Click the extension icon
2. Find the saved workflow in the list
3. Click the **▶ Play** button
4. The workflow plays automatically with:
   - Ghost cursor animation
   - Intelligent element detection
   - Assisted mode if any step is uncertain

### Share a Workflow

1. Click the extension icon
2. Find the workflow you want to share
3. Click the **🔗 Share** button
4. A shareable link is copied to your clipboard
5. Send the link to anyone — they can:
   - View the workflow steps
   - Export as JSON
   - Execute it if using the Chrome extension

## ✨ Features

### Recording
- **Click Detection**: Records all button/link clicks with element fingerprints
- **Input Capture**: Records text input with character-by-character replay
- **Form Actions**: Captures select dropdowns and checkboxes
- **Navigation Tracking**: Detects page navigation and SPA route changes
- **Sensitive Field Handling**: Password fields marked as sensitive, values redacted
- **Shadow DOM Support**: Overlay UI isolated from page styles

### Replay
- **Confidence-Based Execution**:
  - **Auto (85%+)**: Silent execution, no user intervention
  - **Assisted (50-84%)**: Shows found element, highlights for user confirmation
  - **Manual (<50%)**: Pauses and asks for help
- **Ghost Cursor**: Animated cursor following replay actions
- **Multi-Signal Fingerprinting**:
  - ARIA labels (30 pts)
  - Text content (25 pts)
  - Input attributes (15 pts)
  - CSS selectors (10 pts)
  - Position ratio (10 pts)
  - Visibility (5 pts)
- **React/Vue Compatible**: Uses native value setters for framework-aware input
- **Smart Waiting**: Polls for elements up to 5s before failing

### Sharing
- **URL-Based Sharing**: Workflows encoded in URL query params
- **No Server Required**: Pure client-side execution
- **Viewer UI**: Web-based preview of workflow steps
- **JSON Export**: Download workflows as `.json` for backup/sharing

## 📁 File Structure

```
Trigger/
├── extension/
│   ├── manifest.json               # MV3 manifest
│   ├── background/
│   │   └── service-worker.js       # State, message routing, storage
│   ├── content/
│   │   ├── fingerprint.js          # Element detection & resolution
│   │   ├── recorder.js             # Event capture
│   │   ├── replay.js               # Step execution with ghost cursor
│   │   ├── overlay.js              # Floating UI (recording/progress bars)
│   │   └── injector.js             # Entry point, message router
│   ├── popup/
│   │   ├── popup.html              # Popup UI
│   │   └── popup.js                # Workflow management
│   ├── icons/
│   │   ├── icon-16.png
│   │   ├── icon-48.png
│   │   └── icon-128.png
├── viewer/
│   ├── index.html                  # Web-based workflow viewer
│   └── viewer.js                   # Upload, parse, share workflows
├── tests/
│   └── run-tests.js                # 79 comprehensive unit tests
├── package.json
└── README.md
```

## 🔧 Technical Details

### Architecture

**3-Layer Design:**
1. **Capture Layer** (content scripts): Record user interactions
2. **Coordination Layer** (service worker): Manage state, store workflows
3. **Replay Layer** (content scripts): Execute steps with intelligence

### Message Flow

Recording:
```
popup.js START_RECORDING
  → service-worker.js (state = recording)
  → injector.js RECORDER_START
  → recorder.js startRecording() → document listeners
  → user clicks/types
  → recorder.js recordStep() → RECORD_STEP messages
  → service-worker.js (steps array)
popup.js STOP_RECORDING
  → service-worker.js (save workflow to chrome.storage.local)
```

Replay:
```
popup.js START_REPLAY(workflowId)
  → service-worker.js (open new tab with startUrl)
  → content script injects on new page
  → injector.js REPLAY_READY
  → service-worker.js EXECUTE_STEP
  → replay.js executeStep() → ghost cursor + actions
  → STEP_COMPLETED
  → service-worker.js (advance index, send next step or REPLAY_COMPLETE)
```

### Fingerprinting Algorithm

```javascript
generateFingerprint(element)
  → ariaLabel, text, role, tagName, inputType, name, 
    placeholder, selector, xpath, position, visibility

resolveFingerprint(fingerprint)
  → score candidates by:
     1. ARIA match (30pts max)
     2. Text match (25pts max)
     3. Attributes (15pts max)
     4. Selector match (10pts max)
     5. Position ratio (10pts max)
     6. Visibility (5pts max)
  → return { element, confidence }
```

### Confidence Scoring

- **85%+**: Element found with high confidence → auto-execute
- **50-84%**: Medium confidence → show user, highlight element
- **<50%**: Low confidence → pause, ask for help

### Browser APIs Used

- `chrome.storage.local`: Persist workflows
- `chrome.storage.session`: Persist runtime state
- `chrome.tabs.sendMessage`: Content script communication
- `chrome.tabs.create`: Open new tabs for replay
- `history.pushState/replaceState`: SPA navigation detection
- `Element.closest()`: Event delegation
- `Shadow DOM`: Style isolation
- `getComputedStyle()`: Element visibility
- `XPath evaluation`: Cross-page element lookup

## 🧪 Testing

Run the comprehensive test suite:
```bash
npm install --save-dev jsdom
npm test
npm run test:viewer
npm run test:backend
# or
node tests/run-tests.js
```

**81 extension tests + 5 viewer tests + 24 backend tests cover:**
- Manifest validation (MV3 compliance)
- Syntax checking (all 7 JS files)
- Fingerprinting engine (all element types)
- Fingerprint resolution & scoring
- Event capture (click, input, select, keypress)
- Replay execution (navigate, input, actions)
- Overlay UI (recording/replaying modes)
- Service worker logic (state, storage, message routing)
- Popup UI (workflow management)
- Integration round-trips (record → resolve)
- Viewer URL parsing, backend resolution, and extension handoff
- Backend API validation and share-link resolution

## 🔐 Security & Privacy

- **No tracking**: No phones home, entirely local
- **No telemetry**: Your workflows stay in your browser
- **Encrypted sharing**: Use HTTPS when sharing URLs
- **Sensitive field redaction**: Passwords never stored
- **Expanded sensitive masking**: password/card/token/SSN-like fields are redacted; sensitive keypress events are not recorded
- **Content isolation**: Shadow DOM prevents style conflicts
- **No cross-domain access**: Only runs on current domain

### Extension Permission Rationale

- `activeTab`: start recording/replay on the currently active tab.
- `storage`: persist workflows, runtime state, and local debug logs.
- `tabs`: create and update tabs for replay navigation.
- `scripting`: required for resilient extension execution hooks.
- `host_permissions: <all_urls>`: needed because workflows can be recorded/replayed on arbitrary user-selected sites.

For implementation details and current audit notes, see [docs/security-audit.md](./docs/security-audit.md).

## 🐛 Debugging

### View Logs

1. Go to `chrome://extensions`
2. Find Trigger extension
3. Click **"service worker"** link to see background script logs
4. Open DevTools (F12) on any webpage to see content script logs

### Common Issues

**"Element not found" during replay:**
- Page structure changed since recording
- Element hidden or off-screen
- Timing issue: element loads slowly
 - Retry budget exhausted for selector recovery
  → Solution: Wait a few seconds or re-record

**Empty steps after recording:**
- Extension not properly injected
- Page blocked the injection
  → Solution: Check DevTools console for errors

**Replay doesn't start:**
- Tab closed before data loaded
- Cross-origin restriction (can't replay across domains)
  → Solution: Record and replay on same domain

## 📊 Workflow JSON Format

```json
{
  "id": "abc123def456",
  "name": "Login & Submit Form",
  "startUrl": "https://example.com/login",
  "steps": [
    {
      "index": 0,
      "type": "navigate",
      "url": "https://example.com/login",
      "title": "Login Page",
      "timestamp": 1710345600000
    },
    {
      "index": 1,
      "type": "click",
      "target": {
        "role": "textbox",
        "ariaLabel": "",
        "text": "",
        "tagName": "input",
        "inputType": "text",
        "name": "username",
        "placeholder": "Enter username",
        "selector": "input[name='username']",
        "xpath": "//input[@name='username']",
        "position": { "xRatio": 0.5, "yRatio": 0.3 }
      },
      "timestamp": 1710345602000
    },
    {
      "index": 2,
      "type": "input",
      "target": { /* input fingerprint */ },
      "value": "john_doe",
      "sensitive": false,
      "timestamp": 1710345604000
    },
    {
      "index": 3,
      "type": "click",
      "target": { /* button fingerprint */ },
      "navigatesTo": "https://example.com/dashboard",
      "timestamp": 1710345606000
    }
  ],
  "createdAt": 1710345600000
}
```

## 🚦 Roadmap

For a code-verified implementation status and delivery plan, see [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md).

**Phase 0 (Current)**: POC with basic recording/replay ✅
- Element fingerprinting ✅
- Multi-signal detection ✅
- Event capture ✅
- Replay with ghost cursor ✅
- Shareable links ✅
- Test suite ✅

**Phase 1**: Advanced features
- OCR-based element detection
- Screenshot comparison
- Multi-tab workflows
- Conditional branches
- Loop support (repeat actions)

**Phase 2**: Production
- Cloud storage for workflows
- Team collaboration
- Scheduled execution
- API for automation
- Mobile app

**Phase 3**: Enterprise
- Audit logging
- Role-based access
- Workflow versioning
- Performance analytics

## 💡 Tips

### For Best Results

1. **Clear, stable selectors**: Use elements with IDs or data attributes
2. **Avoid timing issues**: Give pages time to load (they auto-delay 300ms between steps)
3. **Test locally first**: Ensure the workflow runs on your own PC before sharing
4. **Keep workflows short**: 5-10 steps is ideal; long workflows are harder to maintain
5. **Use descriptive names**: "Login & Subscribe" is better than "Workflow 1"

### Advanced Usage

**Manual step values:**
- Download workflow as JSON
- Edit step values directly
- Upload modified JSON via viewer

**Export for distribution:**
- Click **↓ Export** to save as `.json`
- Share file via email/Slack
- Recipients can upload to viewer or extension

**Cross-browser sharing:**
- Viewer UI works in any browser
- Execution requires Chrome extension
- Use JSON file for universal distribution

## 📝 License

MIT — Use freely, modify as needed.

## 🤝 Contributing

Found a bug? Have an idea? Open an issue or submit a PR!

---

**Made with ⚡ by Parth**
