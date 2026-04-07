/**
 * Trigger — Element Fingerprinting Engine (Shared)
 *
 * Generates multi-signal fingerprints for DOM elements during recording,
 * and resolves those fingerprints back to elements during replay.
 *
 * Signal priority (most stable → least stable):
 *   1. ARIA role + label
 *   2. Visible text content
 *   3. Input attributes (name, type, placeholder)
 *   4. CSS selector
 *   5. XPath
 *   6. Bounding box ratio (viewport-relative)
 */

export const CONFIDENCE_AUTO = 85;
export const CONFIDENCE_SHOW = 50;

// ── Fingerprint Generation ─────────────────────────────────────────

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

// ── Fingerprint Resolution ─────────────────────────────────────────

export function resolveFingerprint(fingerprint, doc) {
  doc = doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return { element: null, confidence: 0 };

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

// ── Candidate Scoring (exported for freshness evaluation) ──────────

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
    var win = element.ownerDocument ? (element.ownerDocument.defaultView || window) : window;
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

// ── Helpers (private) ──────────────────────────────────────────────

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
    var win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (win) {
      var expectedX = fp.position.xRatio * win.innerWidth;
      var expectedY = fp.position.yRatio * win.innerHeight;
      var elemAtPoint = doc.elementFromPoint(expectedX, expectedY);
      if (elemAtPoint) candidates.add(elemAtPoint);
      [-20, -10, 10, 20].forEach(function (offset) {
        var nearby = doc.elementFromPoint(expectedX + offset, expectedY + offset);
        if (nearby) candidates.add(nearby);
      });
    }
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
  var doc = element.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (element.id) return '#' + CSS.escape(element.id);

  var parts = [];
  var current = element;
  var depth = 0;
  var body = doc ? doc.body : null;

  while (current && current !== body && depth < 5) {
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
  var win = element.ownerDocument ? (element.ownerDocument.defaultView || window) : window;
  var style = win.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  var rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
