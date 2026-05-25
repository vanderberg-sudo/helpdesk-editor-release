// capture.js — Pure DOM analysis functions for click target resolution.
//
// This module is intentionally free of Chrome extension APIs, recording state,
// and side effects. Every function here takes plain DOM nodes / coordinates
// and returns plain values.
//
// Isolation goal: when you collect failing annotation examples, you can write
// tests against these functions directly without needing a recording session.
//
// Imported by content.js. Do not import anything from the extension here.

// ---------------------------------------------------------------------------
// resolveClickTarget
// ---------------------------------------------------------------------------
// Decide which DOM element best represents what the user clicked on.
//
// Strategy:
//   1. Use elementFromPoint as authoritative — it's whatever pixel is at
//      the cursor, ignoring pointer-events:none and offscreen elements.
//   2. Walk up looking for the closest "interactive" ancestor (button, link,
//      role=button, has onclick, etc).
//   3. Among the candidates, pick the one whose bounding box BEST contains
//      the click point — smallest area that still contains (cx, cy).
//      This avoids picking a huge container when a button is right there.
//
// Returns { el, label, label_visible } or null.

export function resolveClickTarget(eventTarget, cx, cy) {
  // Start from the pixel under the cursor — more reliable than e.target.
  let start = document.elementFromPoint(cx, cy) || eventTarget;
  if (!start || start === document.documentElement || start === document.body) {
    start = eventTarget;
  }
  if (!start) return null;

  // Collect ancestor chain from `start` upward, stopping at body.
  const chain = [];
  let node = start;
  while (
    node &&
    node.nodeType === Node.ELEMENT_NODE &&
    node !== document.body &&
    node !== document.documentElement
  ) {
    chain.push(node);
    node = node.parentElement;
    if (chain.length > 12) break; // safety
  }
  if (chain.length === 0) return null;

  // Score each candidate:
  //   +interactive (button/link/role) → strong preference
  //   +contains the click point       → required
  //   smaller area                    → preferred (more specific element)
  let best = null;
  let bestScore = -Infinity;

  for (const el of chain) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const contains =
      cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    if (!contains) continue;

    const area = r.width * r.height;
    const interactive = isInteractiveElement(el);
    const hasLabel = hasMeaningfulLabel(el);

    // Score: interactive elements get a big boost; otherwise prefer smaller
    // area. Log-area so we don't over-reward tiny invisible elements.
    let score = -Math.log(Math.max(area, 1));
    if (interactive) score += 50;
    if (hasLabel) score += 5;
    // Penalize elements too small to be visible (< 8×8) — probably hidden
    // pseudo-elements.
    if (r.width < 8 || r.height < 8) score -= 30;
    // Penalize elements that cover more than half the viewport — they're
    // almost certainly a wrapper, not the interactive target.
    if (area > window.innerWidth * window.innerHeight * 0.5) score -= 30;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (!best) return null;
  const labelInfo = labelFor(best);
  return { el: best, label: labelInfo.label, label_visible: labelInfo.visible };
}

// ---------------------------------------------------------------------------
// tightenToVisibleContent
// ---------------------------------------------------------------------------
// If the resolved click target is a wide container, find the actual
// "visible content" within it (text and icons) and shrink the bounding box
// to that content's union. This prevents annotations from covering empty
// padding/margin areas of wide buttons or list rows.
//
// Only tightens if the result still contains the click point AND is
// meaningfully smaller than the original. Otherwise keeps the original
// (better to over-cover than to miss the click point).
//
// Returns { x, y, width, height } in viewport CSS-pixel coordinates.

export function tightenToVisibleContent(el, originalRect, cx, cy) {
  // Already small enough — no point tightening.
  if (originalRect.width <= 240 && originalRect.height <= 60) {
    return {
      x: originalRect.x,
      y: originalRect.y,
      width: originalRect.width,
      height: originalRect.height,
    };
  }

  const boxes = [];

  // Collect bounding boxes of leaf-level content elements.
  function collect(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent && node.textContent.trim();
      if (t) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) boxes.push(r);
        } catch {}
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    // Icons, images, inputs — leaf-like content elements.
    const tag = node.tagName.toLowerCase();
    if (['svg', 'img', 'i', 'input', 'select'].includes(tag)) {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) boxes.push(r);
      return; // don't recurse into these
    }

    for (const child of node.childNodes) collect(child);
  }
  collect(el);

  if (boxes.length === 0) {
    return {
      x: originalRect.x,
      y: originalRect.y,
      width: originalRect.width,
      height: originalRect.height,
    };
  }

  // Compute union of all content boxes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of boxes) {
    if (r.left   < minX) minX = r.left;
    if (r.top    < minY) minY = r.top;
    if (r.right  > maxX) maxX = r.right;
    if (r.bottom > maxY) maxY = r.bottom;
  }

  // Small padding so the box isn't flush with the text.
  const pad = 4;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  // Clamp to the original rect.
  minX = Math.max(minX, originalRect.left);
  minY = Math.max(minY, originalRect.top);
  maxX = Math.min(maxX, originalRect.right);
  maxY = Math.min(maxY, originalRect.bottom);

  const tightW = maxX - minX;
  const tightH = maxY - minY;

  // Only use tightened box if:
  //   - it still contains the click point
  //   - it's meaningfully smaller than the original (>30% reduction in area)
  //   - it's at least 16×16 px (otherwise it's probably wrong)
  const containsClick = cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
  const originalArea = originalRect.width * originalRect.height;
  const tightArea = tightW * tightH;
  const meaningfullySmaller = tightArea > 0 && tightArea < originalArea * 0.7;

  if (containsClick && meaningfullySmaller && tightW >= 16 && tightH >= 16) {
    return { x: minX, y: minY, width: tightW, height: tightH };
  }
  return {
    x: originalRect.x,
    y: originalRect.y,
    width: originalRect.width,
    height: originalRect.height,
  };
}

// ---------------------------------------------------------------------------
// isInteractiveElement
// ---------------------------------------------------------------------------
// Returns true if el is likely an interactive element the user intentionally
// clicked — a button, link, input, or anything with equivalent semantics.

export function isInteractiveElement(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (
    ['button', 'a', 'input', 'select', 'textarea', 'label', 'summary'].includes(tag)
  ) return true;

  const role = el.getAttribute && el.getAttribute('role');
  if (
    role &&
    [
      'button', 'link', 'menuitem', 'menuitemcheckbox',
      'option', 'tab', 'checkbox', 'radio', 'switch',
    ].includes(role)
  ) return true;

  // Has an onclick or tabindex (likely interactive).
  if (
    el.hasAttribute &&
    (el.hasAttribute('onclick') || el.hasAttribute('tabindex'))
  ) return true;

  // Inline cursor:pointer is a strong signal that someone made this clickable.
  try {
    if (window.getComputedStyle(el).cursor === 'pointer') return true;
  } catch {}

  return false;
}

// ---------------------------------------------------------------------------
// hasMeaningfulLabel
// ---------------------------------------------------------------------------
// Returns true if el has visible text or an aria-label that could serve
// as a useful annotation label.

export function hasMeaningfulLabel(el) {
  if (!el) return false;
  if (el.getAttribute && el.getAttribute('aria-label')) return true;
  const text = (el.innerText || '').trim();
  return text.length > 0 && text.length < 80;
}

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------
// Returns { label, visible } where visible=true means the label text is
// actually rendered on screen within (or near) the clicked element.
//
// Used to decide whether to show a label callout — useful for icon-only
// buttons (visible=false) but redundant when the text is already visible
// (visible=true).

export function labelFor(el) {
  if (!el) return { label: '', visible: false };

  // Visible text wins — it's a good label AND the user can already see it.
  const text = (el.innerText || '').trim();
  if (text && text.length < 80) return { label: text, visible: true };

  // Hidden sources — useful labels the user can't see, so a callout adds info.
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) return { label: aria.trim(), visible: false };

  if (el.tagName === 'IMG') {
    return { label: (el.getAttribute('alt') || 'image').trim(), visible: false };
  }

  const title = el.getAttribute && el.getAttribute('title');
  if (title) return { label: title.trim(), visible: false };

  // Climb one level — if the parent has visible text, treat it as visible.
  if (el.parentElement && el.parentElement !== document.body) {
    const parentText = (el.parentElement.innerText || '').trim();
    if (parentText && parentText.length < 80) {
      return { label: parentText, visible: true };
    }
  }

  return { label: el.tagName.toLowerCase(), visible: false };
}

// ---------------------------------------------------------------------------
// cssPath
// ---------------------------------------------------------------------------
// Generates a short CSS selector path for an element, used as a stable
// identifier for the clicked target in the step record.

export function cssPath(el) {
  if (!(el instanceof Element)) return '';
  const path = [];
  while (el && el.nodeType === Node.ELEMENT_NODE && path.length < 6) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      selector += '#' + el.id;
      path.unshift(selector);
      break;
    }
    let sib = el;
    let nth = 1;
    while (sib.previousElementSibling) {
      sib = sib.previousElementSibling;
      if (sib.nodeName.toLowerCase() === selector) nth++;
    }
    if (nth > 1) selector += `:nth-of-type(${nth})`;
    path.unshift(selector);
    el = el.parentElement;
  }
  return path.join(' > ');
}
