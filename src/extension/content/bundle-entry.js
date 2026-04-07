/**
 * Trigger — Content Script Bundle Entry Point
 *
 * This file is the esbuild entry point only.
 * It imports all content modules as side effects so they register
 * their window.Trigger.* properties before index.js (the injector) runs.
 *
 * index.js is kept as a plain IIFE so it can also be loaded via
 * new Function() in tests (loadInjectorScript).
 */

import './fingerprint.js';
import './overlay.js';
import './recorder.js';
import './replay.js';
import './index.js';
