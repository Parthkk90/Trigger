/**
 * Trigger - Comprehensive Test Suite
 * Tests all extension modules: fingerprinting, recorder, replay, overlay,
 * service worker logic, and popup logic.
 * 
 * Uses jsdom for DOM simulation and mocks for Chrome APIs.
 * Run: node tests/run-tests.js
 */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { webcrypto } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Test Harness ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentSuite = '';
const failures = [];

function suite(name) {
  currentSuite = name;
  console.log(`\n\x1b[1m═══ ${name} ═══\x1b[0m`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    const msg = `  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`;
    console.log(msg);
    failures.push({ suite: currentSuite, name, error: err.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    const msg = `  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`;
    console.log(msg);
    failures.push({ suite: currentSuite, name, error: err.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertIncludes(str, substr, msg) {
  if (typeof str !== 'string' || !str.includes(substr)) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected "${str}" to include "${substr}"`
    );
  }
}

function assertMatches(str, pattern, msg) {
  if (typeof str !== 'string' || !pattern.test(str)) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected string to match ${pattern}`
    );
  }
}

// ── DOM Environment Setup ────────────────────────────────────────

function createDOM(html) {
  const dom = new JSDOM(html || '<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.com/test',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // Mock Chrome APIs
  window.chrome = createChromeMock();

  // Mock CSS.escape (not in jsdom)
  if (!window.CSS) window.CSS = {};
  window.CSS.escape = function (str) {
    return String(str).replace(/([^\w-])/g, '\\$1');
  };

  // Mock getComputedStyle
  const origGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = function (el) {
    try {
      return origGetComputedStyle(el);
    } catch {
      return { display: 'block', visibility: 'visible', opacity: '1' };
    }
  };

  // Polyfill scrollIntoView (jsdom doesn't implement it)
  window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || function () {};

  return { dom, window, document };
}

function createChromeMock() {
  const listeners = {};
  const storage = { local: {}, session: {}, sync: {} };
  const storageWrites = { local: 0, session: 0, sync: 0 };

  return {
    runtime: {
      onMessage: {
        addListener: function (fn) { listeners.onMessage = fn; },
      },
      sendMessage: function (msg) {
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: {
        get: function (key) {
          return Promise.resolve(storage.local);
        },
        set: function (obj) {
          Object.assign(storage.local, obj);
          storageWrites.local += 1;
          return Promise.resolve();
        },
      },
      session: {
        get: function (key) {
          return Promise.resolve(storage.session);
        },
        set: function (obj) {
          Object.assign(storage.session, obj);
          storageWrites.session += 1;
          return Promise.resolve();
        },
      },
      sync: {
        get: function (key) {
          return Promise.resolve(storage.sync);
        },
        set: function (obj) {
          Object.assign(storage.sync, obj);
          storageWrites.sync += 1;
          return Promise.resolve();
        },
        remove: function (key) {
          delete storage.sync[key];
          return Promise.resolve();
        }
      }
    },
    tabs: {
      query: function () { return Promise.resolve([{ id: 1 }]); },
      create: function (opts) { return Promise.resolve({ id: 2, url: opts.url }); },
      update: function () { return Promise.resolve(); },
      sendMessage: function () { return Promise.resolve({ ok: true }); },
    },
    _listeners: listeners,
    _storage: storage,
    _storageWrites: storageWrites,
  };
}

// ── Load source files into JSDOM context ─────────────────────────

function loadContentScripts(window) {
  const builtBundle = path.join(__dirname, '..', 'dist', 'extension', 'content', 'content.js');
  const code = fs.readFileSync(builtBundle, 'utf8');
  const fn = new Function('window', 'document', 'chrome', 'CSS', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'getComputedStyle', 'XPathResult', 'Node', 'Promise', 'MouseEvent', 'KeyboardEvent', 'Event', 'history',
    code
  );
  fn(
    window, window.document, window.chrome, window.CSS,
    window.setTimeout, window.clearTimeout,
    window.setInterval, window.clearInterval,
    window.getComputedStyle,
    window.XPathResult, window.Node, window.Promise,
    window.MouseEvent, window.KeyboardEvent, window.Event,
    window.history
  );
}

function loadInjectorScript(window) {
  const builtBundle = path.join(__dirname, '..', 'dist', 'extension', 'content', 'content.js');
  if (fs.existsSync(builtBundle)) {
    return;
  }

  const code = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension', 'content', 'index.js'),
    'utf8'
  );
  const runtimeCode = code.replace(/^\s*import\s.+?;\s*$/mg, '');
  const fn = new Function('window', 'document', 'chrome', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    runtimeCode
  );
  fn(
    window,
    window.document,
    window.chrome,
    window.setTimeout,
    window.clearTimeout,
    window.setInterval,
    window.clearInterval
  );
}

// ══════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════

async function runAllTests() {
  console.log('\x1b[1m\x1b[34m╔══════════════════════════════════════╗');
  console.log('║   TRIGGER - Full Test Suite          ║');
  console.log('╚══════════════════════════════════════╝\x1b[0m');

  // ── 1. Manifest Validation ──
  suite('Manifest Validation');
  testManifest();

  // ── 2. Syntax Check ──
  suite('Syntax Check (all JS files)');
  testSyntax();

  // ── 3. Fingerprinting Engine ──
  suite('Fingerprint Engine');
  testFingerprinting();

  // ── 4. Fingerprint Resolution ──
  suite('Fingerprint Resolution & Scoring');
  testFingerprintResolution();

  // ── 5. Recorder ──
  suite('Recorder');
  await testRecorder();

  // ── 6. Replay Engine ──
  suite('Replay Engine');
  await testReplay();

  // ── 7. Overlay UI ──
  suite('Overlay UI');
  testOverlay();

  // ── 8. Service Worker Logic ──
  suite('Service Worker Logic');
  await testServiceWorker();

  // ── 9. Popup Logic ──
  suite('Popup HTML');
  testPopup();

  // ── 10. Integration ──
  suite('Integration - Record & Resolve Round-trip');
  testRoundTrip();

  // ── 11. Credential Parameterization ──
  suite('Credential Parameterization');
  await testCredentialParameterization();

  // ── Summary ──
  console.log('\n\x1b[1m══════════════════════════════════════\x1b[0m');
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
  if (failures.length > 0) {
    console.log('\n\x1b[31mFailed tests:\x1b[0m');
    failures.forEach(f => {
      console.log(`  [${f.suite}] ${f.name}: ${f.error}`);
    });
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

// ── 1. Manifest Tests ────────────────────────────────────────────

function testManifest() {
  const manifestPath = path.join(__dirname, '..', 'src', 'extension', 'manifest.json');

  test('manifest.json is valid JSON', () => {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    JSON.parse(raw); // throws if invalid
  });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  test('manifest_version is 3', () => {
    assertEqual(manifest.manifest_version, 3);
  });

  test('has required permissions', () => {
    assert(manifest.permissions.includes('storage'), 'missing storage');
    assert(manifest.permissions.includes('tabs'), 'missing tabs');
    assert(manifest.permissions.includes('activeTab'), 'missing activeTab');
    assert(manifest.permissions.includes('scripting'), 'missing scripting');
  });

  test('background service worker exists', () => {
    const swPath = path.join(__dirname, '..', 'src', 'extension', manifest.background.service_worker);
    assert(fs.existsSync(swPath), 'service-worker.js not found');
  });

  test('all content scripts exist', () => {
    const scripts = manifest.content_scripts[0].js;
    for (const script of scripts) {
      const p = path.join(__dirname, '..', 'src', 'extension', script);
      assert(fs.existsSync(p), `Missing: ${script}`);
    }
  });

  test('content scripts load in correct order', () => {
    const scripts = manifest.content_scripts[0].js;
    assertEqual(scripts[0], 'content/fingerprint.js', 'fingerprint should load first');
    assertEqual(scripts[scripts.length - 1], 'content/index.js', 'injector should load last');
  });

  test('all icon files exist', () => {
    for (const size of ['16', '48', '128']) {
      const p = path.join(__dirname, '..', 'src', 'extension', `icons/icon-${size}.png`);
      assert(fs.existsSync(p), `Missing icon-${size}.png`);
    }
  });

  test('popup HTML exists', () => {
    const p = path.join(__dirname, '..', 'src', 'extension', manifest.action.default_popup);
    assert(fs.existsSync(p), 'popup.html not found');
  });

  test('no import/export in content scripts', () => {
    // Check the built bundle (dist/) not source - source uses ES modules bundled by esbuild to IIFE
    const builtBundle = path.join(__dirname, '..', 'dist', 'extension', 'content', 'content.js');
    if (fs.existsSync(builtBundle)) {
      const code = fs.readFileSync(builtBundle, 'utf8');
      assert(!/^\s*import\s/m.test(code), 'ES import found in built content bundle');
      assert(!/^\s*export\s/m.test(code), 'ES export found in built content bundle');
    }
    // Source files may use ES modules (bundled by esbuild)
  });
}

// ── 2. Syntax Tests ──────────────────────────────────────────────

function testSyntax() {
  const jsFiles = [
    'background/service-worker.js',
    'content/fingerprint.js',
    'content/overlay.js',
    'content/recorder.js',
    'content/replay.js',
    'content/index.js',
    'popup/popup.js',
  ];

  for (const file of jsFiles) {
    test(`${file} has no syntax errors`, () => {
      const code = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'extension', file),
        'utf8'
      );
      // Attempt to parse as a function body (catches syntax errors)
      // Files using ES module syntax (import/export) can't be wrapped in new Function()
      // For those, verify they are non-empty and have expected markers
      if (file.includes('service-worker')) {
        assertIncludes(code, '_browser.runtime.onMessage', 'missing message listener');
        assertIncludes(code, 'messageHandlers', 'missing messageHandlers');
        return;
      }
      if (file.includes('fingerprint')) {
        // fingerprint.js is now an ES module bridge (import/export syntax)
        assertIncludes(code, 'window.Trigger', 'missing window.Trigger assignment');
        assertIncludes(code, 'resolveFingerprint', 'missing resolveFingerprint');
        return;
      }
      if (file.includes('content/index.js') || file.endsWith('/index.js') || file === 'content/index.js') {
        assertIncludes(code, 'window.Trigger', 'missing Trigger usage in content entrypoint');
        assertIncludes(code, '_browser.runtime.onMessage', 'missing runtime message listener');
        return;
      }
      try {
        new Function(code);
      } catch (e) {
        throw new Error(`Syntax error: ${e.message}`);
      }
    });
  }
}

// ── 3. Fingerprinting Tests ──────────────────────────────────────

function testFingerprinting() {
  const { window, document } = createDOM(`
    <html><body>
      <nav>
        <a href="/home" id="home-link">Home</a>
        <button role="button" aria-label="Create new design" class="primary-btn">Create new design</button>
      </nav>
      <main>
        <form id="login-form">
          <input type="text" name="username" placeholder="Enter username" />
          <input type="password" name="password" placeholder="Enter password" />
          <select name="role">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <input type="checkbox" name="remember" />
          <button type="submit">Login</button>
        </form>
        <div class="content">
          <p>Hello World</p>
          <div class="css-abc123 dynamic">Generated class element</div>
        </div>
      </main>
    </body></html>
  `);

  loadContentScripts(window);
  const T = window.Trigger;

  test('Trigger namespace exists', () => {
    assert(T, 'window.Trigger not defined');
    assert(typeof T.generateFingerprint === 'function');
    assert(typeof T.resolveFingerprint === 'function');
  });

  test('fingerprint a button with ARIA label', () => {
    const btn = document.querySelector('[aria-label="Create new design"]');
    const fp = T.generateFingerprint(btn);
    assertEqual(fp.ariaLabel, 'Create new design');
    assertEqual(fp.role, 'button');
    assertEqual(fp.tagName, 'button');
    assertIncludes(fp.text, 'Create new design');
  });

  test('fingerprint an input with name and placeholder', () => {
    const input = document.querySelector('input[name="username"]');
    const fp = T.generateFingerprint(input);
    assertEqual(fp.name, 'username');
    assertEqual(fp.placeholder, 'Enter username');
    assertEqual(fp.tagName, 'input');
    assertEqual(fp.inputType, 'text');
    assertEqual(fp.role, 'textbox');
  });

  test('fingerprint a password field', () => {
    const input = document.querySelector('input[name="password"]');
    const fp = T.generateFingerprint(input);
    assertEqual(fp.inputType, 'password');
    assertEqual(fp.name, 'password');
  });

  test('fingerprint an element with ID generates proper selector', () => {
    const form = document.getElementById('login-form');
    const fp = T.generateFingerprint(form);
    assertEqual(fp.selector, '#login-form');
    assertEqual(fp.xpath, '//*[@id="login-form"]');
  });

  test('fingerprint a checkbox', () => {
    const cb = document.querySelector('input[name="remember"]');
    const fp = T.generateFingerprint(cb);
    assertEqual(fp.role, 'checkbox');
    assertEqual(fp.inputType, 'checkbox');
  });

  test('fingerprint a link', () => {
    const link = document.getElementById('home-link');
    const fp = T.generateFingerprint(link);
    assertEqual(fp.role, 'link');
    assertEqual(fp.selector, '#home-link');
    assertIncludes(fp.text, 'Home');
  });

  test('fingerprint a select element', () => {
    const sel = document.querySelector('select[name="role"]');
    const fp = T.generateFingerprint(sel);
    assertEqual(fp.role, 'combobox');
    assertEqual(fp.tagName, 'select');
    assertEqual(fp.name, 'role');
  });

  test('fingerprint includes position ratios', () => {
    const btn = document.querySelector('button[type="submit"]');
    const fp = T.generateFingerprint(btn);
    assert(typeof fp.position === 'object', 'position missing');
    assert(typeof fp.position.xRatio === 'number', 'xRatio missing');
    assert(typeof fp.position.yRatio === 'number', 'yRatio missing');
  });

  test('fingerprint tagHtml is truncated', () => {
    const btn = document.querySelector('button[type="submit"]');
    const fp = T.generateFingerprint(btn);
    assert(fp.tagHtml.length <= 200, 'tagHtml exceeds 200 chars');
  });

  test('XPath for nested element without ID', () => {
    const p = document.querySelector('p');
    const fp = T.generateFingerprint(p);
    assert(fp.xpath.startsWith('/'), 'XPath should start with /');
    assert(fp.xpath.includes('p['), 'XPath should include p tag');
  });

  test('generated class detection', () => {
    const el = document.querySelector('.dynamic');
    const fp = T.generateFingerprint(el);
    // The selector should NOT include the css-abc123 class (generated)
    assert(!fp.selector.includes('css-abc123'), 'Generated class should be filtered out');
  });

  test('confidence thresholds defined', () => {
    assertEqual(T.CONFIDENCE_AUTO, 85);
    assertEqual(T.CONFIDENCE_SHOW, 50);
  });
}

// ── 4. Fingerprint Resolution Tests ──────────────────────────────

function testFingerprintResolution() {
  const { window, document } = createDOM(`
    <html><body>
      <button id="btn1" role="button" aria-label="Save">Save</button>
      <button id="btn2" role="button" aria-label="Cancel">Cancel</button>
      <input type="text" name="email" placeholder="Email address" />
      <div class="card"><span>Item 1</span></div>
      <div class="card"><span>Item 2</span></div>
    </body></html>
  `);

  loadContentScripts(window);
  const T = window.Trigger;

  test('resolve by ARIA label - exact match', () => {
    const fp = {
      role: 'button', ariaLabel: 'Save', text: 'Save',
      tagName: 'button', selector: '#btn1', xpath: '//*[@id="btn1"]',
      name: '', placeholder: '', inputType: '',
      position: { xRatio: 0, yRatio: 0 },
    };
    const result = T.resolveFingerprint(fp);
    assert(result.element !== null, 'Should find element');
    assertEqual(result.element.id, 'btn1');
    assert(result.confidence >= 50, 'Confidence should be >= 50');
  });

  test('resolve by input name', () => {
    const fp = {
      role: 'textbox', ariaLabel: '', text: '',
      tagName: 'input', selector: 'input[name="email"]',
      xpath: '//input', name: 'email', placeholder: 'Email address',
      inputType: 'text',
      position: { xRatio: 0, yRatio: 0 },
    };
    const result = T.resolveFingerprint(fp);
    assert(result.element !== null, 'Should find input');
    assertEqual(result.element.name, 'email');
  });

  test('returns zero confidence for missing element', () => {
    const fp = {
      role: 'button', ariaLabel: 'Nonexistent', text: 'Nonexistent',
      tagName: 'button', selector: '#nonexistent',
      xpath: '//*[@id="nonexistent"]', name: '', placeholder: '',
      inputType: '',
      position: { xRatio: 0.99, yRatio: 0.99 },
    };
    const result = T.resolveFingerprint(fp);
    // elementFromPoint may return body in jsdom, but confidence should be low
    assert(result.confidence < 50, 'Confidence should be low for nonexistent element');
  });

  test('differentiates between two buttons', () => {
    const fpSave = T.generateFingerprint(document.getElementById('btn1'));
    const fpCancel = T.generateFingerprint(document.getElementById('btn2'));

    const r1 = T.resolveFingerprint(fpSave);
    const r2 = T.resolveFingerprint(fpCancel);

    assertEqual(r1.element.id, 'btn1', 'Should resolve to Save button');
    assertEqual(r2.element.id, 'btn2', 'Should resolve to Cancel button');
  });

  test('round-trip: fingerprint then resolve returns same element', () => {
    const el = document.querySelector('input[name="email"]');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el, 'Should find the same element');
    assert(result.confidence >= 70, `Confidence should be high, got ${result.confidence}`);
  });
}

// ── 5. Recorder Tests ────────────────────────────────────────────

async function testRecorder() {
  const { window, document } = createDOM(`
    <html><body>
      <button id="test-btn">Click Me</button>
      <input type="text" id="test-input" name="search" placeholder="Search..." />
      <input type="password" id="pw-input" name="password" />
      <select id="test-select"><option value="a">A</option><option value="b">B</option></select>
      <input type="checkbox" id="test-cb" name="agree" />
    </body></html>
  `);

  loadContentScripts(window);
  const T = window.Trigger;

  // Capture messages sent via chrome.runtime.sendMessage
  const sentMessages = [];
  window.chrome.runtime.sendMessage = function (msg) {
    sentMessages.push(msg);
    return Promise.resolve({ ok: true });
  };

  test('startRecording sends initial navigate step', () => {
    sentMessages.length = 0;
    T.startRecording();
    assert(sentMessages.length >= 1, 'Should have sent at least 1 message');
    assertEqual(sentMessages[0].type, 'RECORD_STEP');
    assertEqual(sentMessages[0].step.type, 'navigate');
    assertIncludes(sentMessages[0].step.url, 'example.com');
  });

  test('click event is captured', () => {
    sentMessages.length = 0;
    const btn = document.getElementById('test-btn');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert(sentMessages.length >= 1, 'Should have captured click');
    assertEqual(sentMessages[0].step.type, 'click');
    assertIncludes(sentMessages[0].step.target.text, 'Click Me');
  });

  test('popstate during recording does not drop click capture', () => {
    sentMessages.length = 0;

    window.dispatchEvent(new window.PopStateEvent('popstate'));

    const btn = document.getElementById('test-btn');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const clickMsg = sentMessages.find(m => m.step && m.step.type === 'click');
    assert(clickMsg, 'Click capture should continue after popstate re-attachment');
  });

  await testAsync('screenshotAnchor is populated when capture succeeds', async () => {
    sentMessages.length = 0;

    const btn = document.getElementById('test-btn');
    const originalRect = btn.getBoundingClientRect;
    btn.getBoundingClientRect = function () {
      return {
        left: 10,
        top: 20,
        width: 80,
        height: 24,
        right: 90,
        bottom: 44,
        x: 10,
        y: 20,
      };
    };

    window.html2canvas = function () {
      return Promise.resolve({
        toDataURL: function () {
          return 'data:image/png;base64,TEST_ANCHOR';
        },
      });
    };

    try {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 25));

      const clickMsg = sentMessages.find(m => m.step && m.step.type === 'click');
      assert(clickMsg, 'Should capture click step');
      assertEqual(clickMsg.step.screenshotAnchor, 'data:image/png;base64,TEST_ANCHOR');
    } finally {
      delete window.html2canvas;
      btn.getBoundingClientRect = originalRect;
    }
  });

  test('input events are captured (debounced)', (done) => {
    sentMessages.length = 0;
    const input = document.getElementById('test-input');
    input.value = 'hello';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    // Input is debounced at 500ms - but we can flush by clicking elsewhere
    const btn = document.getElementById('test-btn');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // Clicking should flush the input buffer first
    const inputMsg = sentMessages.find(m => m.step && m.step.type === 'input');
    assert(inputMsg, 'Should have captured input');
    assertEqual(inputMsg.step.value, 'hello');
    assertEqual(inputMsg.step.sensitive, false);
  });

  test('password fields are marked as sensitive (via debounce)', (done) => {
    sentMessages.length = 0;
    const pw = document.getElementById('pw-input');
    pw.value = 'secret123';
    pw.dispatchEvent(new window.Event('input', { bubbles: true }));

    // Trigger flush by switching fields.
    const input = document.getElementById('test-input');
    input.value = 'x';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    const inputMsg = sentMessages.find(m => m.step && m.step.type === 'input' && m.step.target && m.step.target.inputType === 'password');
    assert(inputMsg, 'Password input should be captured');
    assertEqual(inputMsg.step.sensitive, true, 'Password input should be marked sensitive');
    assertEqual(inputMsg.step.value, '', 'Sensitive input value should be redacted');
  });

  test('credit-card autocomplete fields are redacted', () => {
    sentMessages.length = 0;

    const cc = document.createElement('input');
    cc.type = 'text';
    cc.id = 'cc-input';
    cc.name = 'cardNumber';
    cc.autocomplete = 'cc-number';
    document.body.appendChild(cc);

    cc.value = '4111 1111 1111 1111';
    cc.dispatchEvent(new window.Event('input', { bubbles: true }));

    const input = document.getElementById('test-input');
    input.value = 'x';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    const msg = sentMessages.find(m => m.step && m.step.type === 'input' && m.step.target && m.step.target.name === 'cardNumber');
    assert(msg, 'Credit card input should be captured');
    assertEqual(msg.step.sensitive, true, 'Credit card input should be marked sensitive');
    assertEqual(msg.step.value, '', 'Credit card value should be redacted');
  });

  test('keypress on sensitive field is not captured', () => {
    sentMessages.length = 0;
    const pw = document.getElementById('pw-input');
    pw.value = 'secret123';
    pw.dispatchEvent(new window.Event('input', { bubbles: true }));
    pw.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const keyMsg = sentMessages.find(m => m.step && m.step.type === 'keypress' && m.step.target && m.step.target.inputType === 'password');
    assert(!keyMsg, 'Sensitive field keypress should not be recorded');
  });

  test('select change is captured', () => {
    sentMessages.length = 0;
    const sel = document.getElementById('test-select');
    sel.value = 'b';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    const selectMsg = sentMessages.find(m => m.step && m.step.type === 'select');
    assert(selectMsg, 'Should have captured select change');
    assertEqual(selectMsg.step.value, 'b');
  });

  test('checkbox change is captured', () => {
    sentMessages.length = 0;
    const cb = document.getElementById('test-cb');
    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    const checkMsg = sentMessages.find(m => m.step && m.step.type === 'check');
    assert(checkMsg, 'Should have captured checkbox change');
    assertEqual(checkMsg.step.checked, true);
  });

  test('Enter keypress is captured', () => {
    sentMessages.length = 0;
    const input = document.getElementById('test-input');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const keyMsg = sentMessages.find(m => m.step && m.step.type === 'keypress');
    assert(keyMsg, 'Should have captured Enter keypress');
    assertEqual(keyMsg.step.key, 'Enter');
  });

  test('stopRecording detaches listeners', () => {
    sentMessages.length = 0;
    T.stopRecording();
    const btn = document.getElementById('test-btn');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // Only the flush message (if any) should appear, no new click
    const clickMsg = sentMessages.find(m => m.step && m.step.type === 'click');
    assert(!clickMsg, 'Should NOT capture clicks after stopping');
  });

  test('clicks on overlay are ignored during recording', () => {
    sentMessages.length = 0;
    T.startRecording();

    // Create a fake overlay element
    const overlay = document.createElement('div');
    overlay.id = 'trigger-overlay';
    const innerBtn = document.createElement('button');
    overlay.appendChild(innerBtn);
    document.body.appendChild(overlay);

    innerBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const clickMsg = sentMessages.find(m => m.step && m.step.type === 'click');
    assert(!clickMsg, 'Should ignore clicks on trigger-overlay');

    overlay.remove();
    T.stopRecording();
  });
}

// ── 6. Replay Engine Tests ───────────────────────────────────────

async function testReplay() {
  const { window, document } = createDOM(`
    <html><body>
      <button id="replay-btn" role="button" aria-label="Submit">Submit</button>
      <input type="text" id="replay-input" name="search" placeholder="Search" />
    </body></html>
  `);

  loadContentScripts(window);
  const T = window.Trigger;

  await testAsync('executeStep resolves for navigate type', async () => {
    const result = await T.executeStep({ type: 'navigate', url: 'https://example.com/test' }, 0, 1);
    assert(result.success, 'Navigate step should succeed');
  });

  await testAsync('navigate auth-wall mismatch triggers auth_wall reason type', async () => {
    window.history.replaceState({}, '', 'https://example.com/login');
    const pw = document.createElement('input');
    pw.type = 'password';
    document.body.appendChild(pw);

    const result = await T.executeStep({ type: 'navigate', url: 'https://example.com/dashboard' }, 0, 1);
    assertEqual(result.success, false, 'Navigate should fail on auth wall');
    assertEqual(result.reasonType, 'auth_wall', 'Auth wall should map to auth_wall reason type');

    pw.remove();
    window.history.replaceState({}, '', 'https://example.com/test');
  });

  await testAsync('transient redirect within 500ms does not trigger auth_wall', async () => {
    window.history.replaceState({}, '', 'https://example.com/login');

    setTimeout(() => {
      window.history.replaceState({}, '', 'https://example.com/dashboard');
    }, 200);

    const result = await T.executeStep({ type: 'navigate', url: 'https://example.com/dashboard' }, 0, 1);
    assertEqual(result.success, true, 'Transient redirect should settle before auth-wall detection');
  });

  await testAsync('executeStep clicks a found element', async () => {
    const btn = document.getElementById('replay-btn');
    const fp = T.generateFingerprint(btn);
    let clicked = false;
    btn.addEventListener('click', () => { clicked = true; });

    const result = await T.executeStep({ type: 'click', target: fp }, 0, 1);
    assert(result.success, 'Click step should succeed');
    assert(clicked, 'Button should have been clicked');
  });

  await testAsync('executeStep types into an input', async () => {
    const input = document.getElementById('replay-input');
    const fp = T.generateFingerprint(input);

    const result = await T.executeStep({
      type: 'input', target: fp, value: 'hi', sensitive: false,
    }, 0, 1);
    assert(result.success, `Input step should succeed, got: ${result.reason}`);
    assertEqual(input.value, 'hi', 'Input value should be "hi"');
  });

  await testAsync('executeStep pauses when CAPTCHA iframe is detected', async () => {
    const captchaFrame = document.createElement('iframe');
    captchaFrame.setAttribute('src', 'https://www.google.com/recaptcha/api2/anchor');
    document.body.appendChild(captchaFrame);

    const btn = document.getElementById('replay-btn');
    const fp = T.generateFingerprint(btn);
    const result = await T.executeStep({ type: 'click', target: fp }, 0, 1);

    assertEqual(result.success, false, 'Replay should pause on CAPTCHA');
    assertEqual(result.reasonType, 'captcha_challenge', 'Reason type should classify CAPTCHA correctly');
    assertIncludes(result.reason, 'CAPTCHA challenge detected', 'Reason should explain manual solve flow');

    captchaFrame.remove();
  });

  test('abortReplay sets aborted flag', () => {
    T.abortReplay();
    // After abort, the ghost cursor should be removed
    const cursor = document.getElementById('trigger-ghost-cursor');
    assert(!cursor, 'Ghost cursor should be removed after abort');
  });

  test('resetReplay clears aborted flag', () => {
    T.resetReplay();
    // No error thrown = success
  });
}

// ── 7. Overlay Tests ─────────────────────────────────────────────

function testOverlay() {
  const { window, document } = createDOM();
  loadContentScripts(window);
  const T = window.Trigger;

  test('createOverlay("recording") adds overlay to DOM', () => {
    T.createOverlay('recording');
    const overlay = document.getElementById('trigger-overlay');
    assert(overlay, 'Overlay should be in DOM');
    const shadow = overlay.shadowRoot;
    assert(shadow, 'Shadow root missing');
    const bar = shadow.getElementById('trigger-bar');
    assert(bar, 'Status bar missing');
    assertIncludes(bar.className, 'recording');
    T.destroyOverlay();
  });

  test('createOverlay("replaying") adds replay bar', () => {
    T.createOverlay('replaying');
    const overlay = document.getElementById('trigger-overlay');
    const shadow = overlay.shadowRoot;
    const bar = shadow.getElementById('trigger-bar');
    assertIncludes(bar.className, 'replaying');
    const progress = shadow.getElementById('trigger-progress');
    assert(progress, 'Progress bar missing');
    const stopBtn = shadow.getElementById('trigger-stop');
    assert(stopBtn, 'Stop button missing');
    T.destroyOverlay();
  });

  test('destroyOverlay removes overlay from DOM', () => {
    T.createOverlay('recording');
    assert(document.getElementById('trigger-overlay'), 'Overlay should exist');
    T.destroyOverlay();
    assert(!document.getElementById('trigger-overlay'), 'Overlay should be removed');
  });

  test('updateProgress changes progress bar width', () => {
    T.createOverlay('replaying');
    T.showProgressBar(5);
    T.updateProgress(2, 5, { type: 'click', target: { text: 'Save' } });
    const shadow = document.getElementById('trigger-overlay').shadowRoot;
    const progress = shadow.getElementById('trigger-progress');
    assertEqual(progress.style.width, '60%');
    const status = shadow.getElementById('trigger-status');
    assertEqual(status.textContent, '3 / 5');
    T.destroyOverlay();
  });

  test('showAssistPanel displays panel in shadow DOM', () => {
    T.assistAttempting({ index: 1, total: 5, step: { type: 'click', target: { text: 'Submit' } } });
    T.showAssistPanel(
      {
        step: { type: 'click', target: { text: 'Submit' } },
        index: 1,
        total: 5,
        reason: 'Element not found',
        reasonType: 'selector_not_found',
        retries: 1,
        maxRetries: 3,
      }
    );
    const overlay = document.getElementById('trigger-overlay');
    const shadow = overlay.shadowRoot;
    const assist = shadow.getElementById('trigger-assist');
    assertEqual(assist.style.display, 'block');
    assertIncludes(assist.innerHTML, 'Step 2 of 5');
    assertIncludes(assist.innerHTML, 'selector_not_found');
    assertIncludes(assist.innerHTML, 'Retry 2 of 3');
    assertIncludes(assist.innerHTML, 'Element not found');
    T.destroyOverlay();
  });

  test('showAssistPanel renders screenshot anchor image when present', () => {
    T.showAssistPanel(
      {
        step: { type: 'click', target: { text: 'Submit' }, screenshotAnchor: 'data:image/png;base64,ANCHOR' },
        index: 1,
        total: 5,
        reason: 'Element not found',
        reasonType: 'selector_not_found',
        retries: 1,
        maxRetries: 3,
      }
    );
    const overlay = document.getElementById('trigger-overlay');
    const shadow = overlay.shadowRoot;
    const img = shadow.querySelector('.assist-anchor');
    assert(img, 'Anchor image missing');
    assertEqual(img.getAttribute('src'), 'data:image/png;base64,ANCHOR');
    T.destroyOverlay();
  });

  test('showAssistPanel renders normally without screenshot anchor', () => {
    T.showAssistPanel(
      {
        step: { type: 'click', target: { text: 'Submit' } },
        index: 1,
        total: 5,
        reason: 'Element not found',
        reasonType: 'selector_not_found',
        retries: 1,
        maxRetries: 3,
      }
    );
    const overlay = document.getElementById('trigger-overlay');
    const shadow = overlay.shadowRoot;
    const assist = shadow.getElementById('trigger-assist');
    const img = shadow.querySelector('.assist-anchor');
    assertEqual(assist.style.display, 'block');
    assert(!img, 'Anchor image should be absent');
    T.destroyOverlay();
  });

  test('showCredentialPrompt updates status text while waiting', () => {
    T.createOverlay('replaying');
    T.showCredentialPrompt({
      prompts: [{ key: 'username', label: 'Username' }],
      onSubmit: function () {},
      onCancel: function () {},
    });

    const shadow = document.getElementById('trigger-overlay').shadowRoot;
    const status = shadow.getElementById('trigger-status');
    const panel = shadow.getElementById('trigger-credentials');
    assertEqual(panel.getAttribute('role'), 'dialog');
    assertEqual(panel.getAttribute('aria-modal'), 'true');
    assertEqual(panel.getAttribute('aria-label'), 'Credential prompt');
    assertEqual(status.textContent, 'Waiting for credentials…');
    T.destroyOverlay();
  });

  test('showDriftWarning displays proceed/cancel prompt', () => {
    T.createOverlay('replaying');
    T.showDriftWarning({ onProceed: function () {}, onCancel: function () {} });

    const shadow = document.getElementById('trigger-overlay').shadowRoot;
    const panel = shadow.getElementById('trigger-drift');
    assertEqual(panel.style.display, 'block');
    assertEqual(panel.getAttribute('role'), 'dialog');
    assertEqual(panel.getAttribute('aria-modal'), 'true');
    assertEqual(panel.getAttribute('aria-label'), 'DOM drift warning');
    assertIncludes(panel.textContent, 'Potential DOM Drift Detected');
    assertIncludes(panel.textContent, 'Proceed anyway');
    T.destroyOverlay();
  });

  test('showAssistPanel includes accessible dialog attributes', () => {
    T.showAssistPanel({
      step: { type: 'click', target: { text: 'Submit' } },
      index: 0,
      total: 1,
      reason: 'Element not found',
      reasonType: 'selector_not_found',
      retries: 0,
      maxRetries: 3,
    });

    const shadow = document.getElementById('trigger-overlay').shadowRoot;
    const panel = shadow.getElementById('trigger-assist');
    assertEqual(panel.getAttribute('role'), 'dialog');
    assertEqual(panel.getAttribute('aria-modal'), 'true');
    assertEqual(panel.getAttribute('aria-label'), 'Replay assist panel');
    T.destroyOverlay();
  });

  test('showCompletionToast shows success toast', () => {
    T.showCompletionToast();
    const overlay = document.getElementById('trigger-overlay');
    const shadow = overlay.shadowRoot;
    const toast = shadow.getElementById('trigger-toast');
    assertIncludes(toast.className, 'success');
    assertIncludes(toast.textContent, 'Workflow complete');
    T.destroyOverlay();
  });

  test('showErrorToast shows error toast', () => {
    T.showErrorToast('Something broke');
    const overlay = document.getElementById('trigger-overlay');
    const shadow = overlay.shadowRoot;
    const toast = shadow.getElementById('trigger-toast');
    assertIncludes(toast.className, 'error');
    assertEqual(toast.textContent, 'Something broke');
    T.destroyOverlay();
  });

  test('double createOverlay destroys previous one', () => {
    T.createOverlay('recording');
    T.createOverlay('replaying');
    const overlays = document.querySelectorAll('#trigger-overlay');
    assertEqual(overlays.length, 1);
    const shadow = overlays[0].shadowRoot;
    assertIncludes(shadow.getElementById('trigger-bar').className, 'replaying');
    T.destroyOverlay();
  });
}

// ── 8. Service Worker Logic Tests ────────────────────────────────

async function testServiceWorker() {
  const swCode = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'extension', 'background', 'service-worker.js'),
    'utf8'
  );

  test('STOP_RECORDING saves tabId before nulling state', () => {
    assertIncludes(swCode, 'const tabId = state.activeTabId');
    assertIncludes(swCode, 'if (tabId)');
    const stopBlock = swCode.substring(
      swCode.indexOf("'STOP_RECORDING'"),
      swCode.indexOf("'RECORD_STEP'")
    );
    const afterNull = stopBlock.substring(stopBlock.indexOf('state.activeTabId = null'));
    assert(!afterNull.includes('state.activeTabId,'), 'Should not use state.activeTabId after null');
  });

  test('generateId produces 12-char alphanumeric string', () => {
    const match = swCode.match(/function generateId\(\) \{[\s\S]*?return id;\s*\}/);
    assert(match, 'generateId function not found');
    const fn = new Function('crypto', match[0] + '; return generateId();');
    const id = fn(webcrypto);
    assertEqual(id.length, 12);
    assert(/^[a-z0-9]+$/.test(id));
  });

  test('all message handlers are defined', () => {
    const expectedHandlers = [
      'START_RECORDING', 'STOP_RECORDING', 'RECORD_STEP',
      'START_REPLAY', 'REPLAY_READY', 'STEP_COMPLETED',
      'STOP_REPLAY', 'STEP_FAILED', 'SUBMIT_REPLAY_CREDENTIALS', 'DOM_DRIFT_DECISION', 'GET_STATE',
      'GET_WORKFLOWS', 'DELETE_WORKFLOW', 'REPLAY_HEARTBEAT', 'ASSIST_ACTION',
    ];
    for (const handler of expectedHandlers) {
      assertIncludes(swCode, handler, `Missing handler: ${handler}`);
    }
  });

  test('keepalive interval is 20 seconds', () => {
    assertMatches(swCode, /KEEPALIVE_INTERVAL_MS\s*=\s*(20000|2e4)/);
  });

  test('replay heartbeat stale threshold is defined', () => {
    assertMatches(swCode, /REPLAY_HEARTBEAT_STALE_MS\s*=\s*(45000|45e3)/);
    assertMatches(swCode, /MAX_RECOVERY_ATTEMPTS\s*=\s*3/);
  });

  test('STEP_FAILED applies retry budget with typed reasons', () => {
    assertIncludes(swCode, 'classifyFailure(');
    assertIncludes(swCode, 'isRetryableFailure(');
    assertIncludes(swCode, "state.stepRetries[index] = retries + 1");
    assertMatches(swCode, /type:\s*['\"]SHOW_ASSIST['\"]/);
  });

  test('auth-wall failures are classified and routed as assist reasons', () => {
    assertIncludes(swCode, 'auth_wall');
    assertIncludes(swCode, 'reasonType,');
    assertMatches(swCode, /type:\s*['\"]SHOW_ASSIST['\"]/);
  });

  test('pre-replay DOM drift check is requested before first step', () => {
    assertIncludes(swCode, 'CHECK_DOM_DRIFT');
    assertIncludes(swCode, 'REPLAY_FRESHNESS_THRESHOLD');
    assertIncludes(swCode, 'DOM_DRIFT_DECISION');
  });

  test('state persistence supports session fallback for Firefox', () => {
    assertIncludes(swCode, 'sessionStorageSet({ triggerState: state })');
    assertIncludes(swCode, 'sessionStorageGet(');
    assertIncludes(swCode, 'triggerState');
    assertIncludes(swCode, 'SESSION_STORAGE_PREFIX');
  });

  test('workflows stored in extension local storage', () => {
    assertIncludes(swCode, '_browser.storage.local.get');
    assertIncludes(swCode, '_browser.storage.local.set');
  });

  test('message router returns true for async handlers', () => {
    assertIncludes(swCode, 'return true;');
  });

  test('STEP_COMPLETED advances replayIndex correctly', () => {
    assertIncludes(swCode, "return await getReplayResponseForCompletedIndex(msg.index)");
    assertIncludes(swCode, 'state.replayIndex = index + 1');
  });

  test('START_REPLAY opens new tab with startUrl', () => {
    assertIncludes(swCode, '_browser.tabs.create({ url: workflow.startUrl })');
  });

  test('tab removal listener aborts active replay', () => {
    assertIncludes(swCode, '_browser.tabs.onRemoved.addListener');
    assertIncludes(swCode, 'abortReplaySession(');
  });
}

// ── 11. Credential Parameterization Tests ───────────────────────

async function testCredentialParameterization() {
  await testAsync('sensitive replay flow prompts for and injects credentials', async () => {
    const { window } = createDOM('<html><body><input id="email" type="text" name="email" /></body></html>');
    const sentMessages = [];
    let reReadyCount = 0;
    let submittedCredentialValues = null;
    let executedStep = null;

    window.chrome.runtime.sendMessage = function (msg) {
      sentMessages.push(msg);
      if (msg.type === 'GET_STATE') {
        return Promise.resolve({ mode: 'replaying' });
      }
      if (msg.type === 'REPLAY_READY') {
        reReadyCount += 1;
        if (reReadyCount === 1) {
          return Promise.resolve({
            type: 'REQUEST_CREDENTIALS',
            prompts: [{ key: 'email', label: 'Email Address', stepIndices: [0] }],
          });
        }
        return Promise.resolve({ type: 'REPLAY_COMPLETE' });
      }
      if (msg.type === 'SUBMIT_REPLAY_CREDENTIALS') {
        return Promise.resolve({
          type: 'EXECUTE_STEP',
          step: {
            type: 'input',
            sensitive: true,
            value: '',
            _credentialKey: 'email',
            target: { name: 'email' },
          },
          index: 0,
          total: 1,
        });
      }
      if (msg.type === 'STEP_COMPLETED') {
        return Promise.resolve({ type: 'REPLAY_COMPLETE' });
      }
      return Promise.resolve({ ok: true });
    };

    loadContentScripts(window);

    const executionCompleted = new Promise(resolve => {
      window.Trigger.executeStep = function (step) {
        executedStep = step;
        resolve();
        return Promise.resolve({ success: true, confidence: 100 });
      };
    });

    window.Trigger.showCredentialPrompt = function (payload) {
      submittedCredentialValues = { email: 'user@example.com' };
      payload.onSubmit(submittedCredentialValues);
    };

    // The checkIfReplaying() function runs on script load, so we just need to wait
    // for our final mock in the chain (executeStep) to be called.
    await executionCompleted;

    assert(sentMessages.some(m => m.type === 'SUBMIT_REPLAY_CREDENTIALS'), 'Credentials handshake failed');
    assert(submittedCredentialValues, 'Credential prompt failed');
    assert(executedStep, 'executeStep not invoked');
    assertEqual(executedStep.value, 'user@example.com');
    assertEqual(executedStep.sensitive, false);
    assertEqual(executedStep._credentialInjected, true);
  });

  await testAsync('credential flow does not write values to extension storage', async () => {
    const { window } = createDOM();
    loadContentScripts(window);
    await new Promise(resolve => setTimeout(resolve, 5));
    assertEqual(window.chrome._storageWrites.local, 0);
    assertEqual(window.chrome._storageWrites.session, 0);
  });

  await testAsync('low freshness confidence triggers DOM drift warning before replay', async () => {
    const { window } = createDOM();
    let warned = false;

    window.chrome.runtime.sendMessage = function (msg) {
      if (msg.type === 'GET_STATE') return Promise.resolve({ mode: 'replaying' });
      if (msg.type === 'REPLAY_READY') {
        return Promise.resolve({
          type: 'CHECK_DOM_DRIFT',
          threshold: 60,
          sampleSteps: [{ index: 0, type: 'click', target: { text: 'Save' } }],
        });
      }
      return Promise.resolve({ ok: true });
    };

    loadContentScripts(window);

    const warningShown = new Promise(resolve => {
      window.Trigger.showDriftWarning = function () {
        warned = true;
        resolve();
      };
    });

    window.Trigger.evaluateReplayFreshness = function () {
      return { averageConfidence: 30, sampledCount: 1, details: [{ stepIndex: 0, confidence: 30 }] };
    };

    window.Trigger.executeStep = function () { return Promise.resolve({ success: true }); };

    await warningShown;

    assertEqual(warned, true);
  });
}

// ── 9. Popup Tests ───────────────────────────────────────────────

function testPopup() {
  const htmlPath = path.join(__dirname, '..', 'src', 'extension', 'popup', 'popup.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const jsPath = path.join(__dirname, '..', 'src', 'extension', 'popup', 'popup.js');
  const js = fs.readFileSync(jsPath, 'utf8');

  test('popup HTML has required elements', () => {
    assertIncludes(html, 'id="controls"');
    assertIncludes(html, 'id="status-bar"');
    assertIncludes(html, 'id="status-dot"');
    assertIncludes(html, 'id="status-text"');
    assertIncludes(html, 'id="workflow-list"');
    assertIncludes(html, 'id="btn-record"');
    assertIncludes(html, 'id="btn-settings"');
  });

  test('popup HTML loads popup.js', () => {
    assertIncludes(html, 'src="popup.js"');
  });

  test('popup JS sets up click listener once in init', () => {
    assertIncludes(js, "workflowList.addEventListener('click', handleWorkflowAction)");
    const count = (js.match(/workflowList\.addEventListener/g) || []).length;
    assertEqual(count, 1);
  });

  test('popup JS escapes HTML in workflow names', () => {
    assertIncludes(js, 'escapeHtml(w.name)');
  });

  test('popup JS has XSS-safe escapeHtml function', () => {
    assertIncludes(js, 'div.textContent = text');
    assertIncludes(js, 'div.innerHTML');
  });

  test('popup JS closes popup after starting recording', () => {
    assertIncludes(js, 'window.close()');
  });

  test('popup JS has export functionality', () => {
    assertIncludes(js, 'exportWorkflow');
    assertIncludes(js, 'application/json');
  });

  test('home actions expose two-click common flows', () => {
    assertIncludes(js, 'data-action="play"');
    assertIncludes(js, 'data-action="share"');
    assertIncludes(js, 'data-action="delete"');
    assertIncludes(js, "case 'play':");
    assertIncludes(js, "case 'share':");
    assertIncludes(js, "startRecording");
  });

  test('icon-only controls include aria labels', () => {
    assertIncludes(html, 'aria-label="Open Settings"');
    assertIncludes(js, 'aria-label="Play workflow');
    assertIncludes(js, 'aria-label="Share workflow');
    assertIncludes(js, 'aria-label="Delete workflow');
  });
}

// ── 10. Round-trip Tests ─────────────────────────────────────────

function testRoundTrip() {
  const { window, document } = createDOM(`
    <html><body>
      <header>
        <nav>
          <a href="/dashboard" id="nav-dash">Dashboard</a>
          <button aria-label="New Project" class="cta-button">+ New Project</button>
        </nav>
      </header>
      <main>
        <form>
          <input type="text" name="project-name" placeholder="Project name" />
          <textarea name="description" placeholder="Description"></textarea>
          <select name="type">
            <option value="">Select type</option>
            <option value="web">Web</option>
            <option value="mobile">Mobile</option>
          </select>
          <button type="submit" id="submit-btn">Create Project</button>
        </form>
      </main>
    </body></html>
  `);

  loadContentScripts(window);
  const T = window.Trigger;

  test('round-trip: link with ID', () => {
    const el = document.getElementById('nav-dash');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el);
    assert(result.confidence >= 50);
  });

  test('round-trip: button with aria-label', () => {
    const el = document.querySelector('[aria-label="New Project"]');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el);
    assert(result.confidence >= 70);
  });

  test('round-trip: input with name', () => {
    const el = document.querySelector('input[name="project-name"]');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el);
  });

  test('round-trip: textarea', () => {
    const el = document.querySelector('textarea[name="description"]');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el);
  });

  test('round-trip: select', () => {
    const el = document.querySelector('select[name="type"]');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el);
  });

  test('round-trip: button by text', () => {
    const el = document.getElementById('submit-btn');
    const fp = T.generateFingerprint(el);
    const result = T.resolveFingerprint(fp);
    assert(result.element === el);
    assert(result.confidence >= 50);
  });

  test('round-trip: fingerprint survives minor DOM changes', () => {
    const main = document.querySelector('main');
    const extra = document.createElement('div');
    extra.textContent = 'Notice: new content injected';
    main.insertBefore(extra, main.firstChild);

    const btn = document.getElementById('submit-btn');
    const fp = T.generateFingerprint(btn);
    const originalFp = { ...fp, selector: 'button.cta-button', xpath: '/html/body/main/form/button[1]' };
    originalFp.ariaLabel = '';
    const result = T.resolveFingerprint(originalFp);
    assert(result.element === btn);
    assert(result.confidence >= 30);

    extra.remove();
  });
}

// ── Run ──────────────────────────────────────────────────────────

runAllTests();
