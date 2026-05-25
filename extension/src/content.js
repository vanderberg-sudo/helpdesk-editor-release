// content.js — Injected into the recorded tab.
// Listens for clicks, sends metadata to the background worker, draws
// transient capture feedback.
//
// The recording PANEL lives in a separate Chrome popup window (managed
// by the background worker) and is never injected into the captured page.
// This guarantees the panel never appears in screenshots.
//
// NOTE: This file is injected by chrome.scripting.executeScript() which runs
// scripts as classic (non-module) scripts. ES module imports are not supported
// in that context. The DOM analysis functions below are intentionally inlined
// from capture.js for this reason.
//
// capture.js remains the canonical isolated module for testing and iterating
// on annotation accuracy. When improving heuristics, edit capture.js — then
// copy the changed functions back here.

(() => {
  if (window.__stepcast_content_loaded) return;
  window.__stepcast_content_loaded = true;

  let recording = false;
  let dom_mutation_since_last = false;

  const mutationObserver = new MutationObserver(() => {
    dom_mutation_since_last = true;
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_LISTENING':
        recording = true;
        attachClickListener();
        mutationObserver.observe(document.body, { childList: true, subtree: true });
        sendResponse({ ok: true });
        break;
      case 'STOP_LISTENING':
        recording = false;
        detachClickListener();
        mutationObserver.disconnect();
        sendResponse({ ok: true });
        break;
    }
    return true;
  });

  // ---- Click listening ----

  function clickHandler(e) {
    if (!recording) return;
    if (e.button !== 0) return;

    const cx = e.clientX;
    const cy = e.clientY;
    const target = resolveClickTarget(e.target, cx, cy);
    if (!target) return;

    const rect = target.el.getBoundingClientRect();

    // IMPORTANT: bounding_box is in CSS-pixel VIEWPORT coordinates — no
    // scroll offset added. chrome.tabs.captureVisibleTab() photographs the
    // current viewport, NOT the full document, so adding scrollX/scrollY
    // would misalign the annotation. device_pixel_ratio lets the renderer
    // scale up to native screenshot pixels on Retina/HiDPI displays.
    let bbox;
    if (
      cx >= rect.left && cx <= rect.right &&
      cy >= rect.top  && cy <= rect.bottom &&
      rect.width > 0  && rect.height > 0
    ) {
      const tight = tightenToVisibleContent(target.el, rect, cx, cy);
      bbox = { x: tight.x, y: tight.y, w: tight.width, h: tight.height };
    } else {
      bbox = { x: cx - 40, y: cy - 20, w: 80, h: 40 };
    }

    const click = {
      url: location.href,
      selector: cssPath(target.el),
      element_label: target.label,
      label_visible: target.label_visible,
      bounding_box: bbox,
      device_pixel_ratio: window.devicePixelRatio || 1,
      timestamp: Date.now(),
      dom_mutation_since_last,
    };

    dom_mutation_since_last = false;

    chrome.runtime.sendMessage({ type: 'CLICK_CAPTURED', click }).catch(() => {});

    setTimeout(
      () => showCaptureIndicator(bbox.x - window.scrollX, bbox.y - window.scrollY, bbox.w, bbox.h),
      150
    );
  }

  function attachClickListener() {
    document.addEventListener('mousedown', clickHandler, true);
  }

  function detachClickListener() {
    document.removeEventListener('mousedown', clickHandler, true);
  }

  // ---- Capture indicator ----

  function showCaptureIndicator(x, y, w, h) {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-stepcast-indicator', '1');
    overlay.style.cssText = `
      position: fixed;
      left: ${x - 4}px;
      top: ${y - 4}px;
      width: ${w + 8}px;
      height: ${h + 8}px;
      border: 2px dashed #185fa5;
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483646;
      animation: stepcastCaptureFade 600ms ease-out forwards;
    `;
    if (!document.getElementById('stepcast-indicator-style')) {
      const style = document.createElement('style');
      style.id = 'stepcast-indicator-style';
      style.textContent = `
        @keyframes stepcastCaptureFade {
          0%   { opacity: 1; transform: scale(1.05); }
          100% { opacity: 0; transform: scale(1); }
        }
      `;
      document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 600);
  }

  // ---- DOM analysis (inlined from capture.js) ----
  //
  // These functions are copied from capture.js. capture.js remains the
  // canonical source — edit there first, then copy changes back here.

  function resolveClickTarget(eventTarget, cx, cy) {
    let start = document.elementFromPoint(cx, cy) || eventTarget;
    if (!start || start === document.documentElement || start === document.body) {
      start = eventTarget;
    }
    if (!start) return null;

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
      if (chain.length > 12) break;
    }
    if (chain.length === 0) return null;

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

      let score = -Math.log(Math.max(area, 1));
      if (interactive) score += 50;
      if (hasLabel) score += 5;
      if (r.width < 8 || r.height < 8) score -= 30;
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

  function tightenToVisibleContent(el, originalRect, cx, cy) {
    if (originalRect.width <= 240 && originalRect.height <= 60) {
      return {
        x: originalRect.x,
        y: originalRect.y,
        width: originalRect.width,
        height: originalRect.height,
      };
    }

    const boxes = [];

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

      const tag = node.tagName.toLowerCase();
      if (['svg', 'img', 'i', 'input', 'select'].includes(tag)) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) boxes.push(r);
        return;
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

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of boxes) {
      if (r.left   < minX) minX = r.left;
      if (r.top    < minY) minY = r.top;
      if (r.right  > maxX) maxX = r.right;
      if (r.bottom > maxY) maxY = r.bottom;
    }

    const pad = 4;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    minX = Math.max(minX, originalRect.left);
    minY = Math.max(minY, originalRect.top);
    maxX = Math.min(maxX, originalRect.right);
    maxY = Math.min(maxY, originalRect.bottom);

    const tightW = maxX - minX;
    const tightH = maxY - minY;

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

  function isInteractiveElement(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'input', 'select', 'textarea', 'label', 'summary'].includes(tag)) return true;

    const role = el.getAttribute && el.getAttribute('role');
    if (role && ['button','link','menuitem','menuitemcheckbox','option','tab','checkbox','radio','switch'].includes(role)) return true;

    if (el.hasAttribute && (el.hasAttribute('onclick') || el.hasAttribute('tabindex'))) return true;

    try {
      if (window.getComputedStyle(el).cursor === 'pointer') return true;
    } catch {}

    return false;
  }

  function hasMeaningfulLabel(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute('aria-label')) return true;
    const text = (el.innerText || '').trim();
    return text.length > 0 && text.length < 80;
  }

  function labelFor(el) {
    if (!el) return { label: '', visible: false };

    const text = (el.innerText || '').trim();
    if (text && text.length < 80) return { label: text, visible: true };

    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return { label: aria.trim(), visible: false };

    if (el.tagName === 'IMG') {
      return { label: (el.getAttribute('alt') || 'image').trim(), visible: false };
    }

    const title = el.getAttribute && el.getAttribute('title');
    if (title) return { label: title.trim(), visible: false };

    if (el.parentElement && el.parentElement !== document.body) {
      const parentText = (el.parentElement.innerText || '').trim();
      if (parentText && parentText.length < 80) {
        return { label: parentText, visible: true };
      }
    }

    return { label: el.tagName.toLowerCase(), visible: false };
  }

  function cssPath(el) {
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

})();