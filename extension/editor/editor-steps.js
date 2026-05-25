// editor-steps.js — Step rendering, ordering, manual-step creation, image upload.
//
// Owns:
//   renderRail()                   — left-rail step list
//   renderSteps()                  — main step cards
//   renderStepCard()               — single card HTML
//   renderAnnotationsForAllCards() — SVG annotation overlays
//   groupSteps()                   — raw steps[] → groups[][]
//   applyGroupOrder()              — sort groups by saved meta.group_order
//   saveGroupOrder()               — persist meta.group_order to IndexedDB
//   bindStepActions()              — wire add / move / regen / delete / upload handlers

import { putStep, putRecording, putBlob, getBlob, deleteStep, deleteBlob, uuid } from '../src/db.js';
import { renderAnnotationsSvg } from './annotations.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_EXTENSIONS = '.png, .jpg, .jpeg, .webp, .gif';
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Markdown toolbar ─────────────────────────────────────────────────────────
// Floating toolbar that appears when text is selected in a description textarea.
// Wraps selected text in markdown syntax — no library, no contenteditable.

let _toolbar = null;
let _activeTextarea = null;

function getOrCreateToolbar() {
  if (_toolbar) return _toolbar;
  _toolbar = document.createElement('div');
  _toolbar.className = 'md-toolbar';
  _toolbar.innerHTML = `
    <button class="md-btn" data-md="bold"    title="Bold"             style="color:#fff;font-weight:700;">B</button>
    <button class="md-btn" data-md="italic"  title="Italic"           style="color:#fff;font-style:italic;">I</button>
    <button class="md-btn" data-md="link"    title="Insert link"      style="color:#85b7eb;">Link</button>
    <button class="md-btn" data-md="callout" title="Tip callout block" style="color:#fff;">Tip</button>
  `;
  document.body.appendChild(_toolbar);
  // Prevent blur on textarea when clicking a button.
  _toolbar.addEventListener('mousedown', (e) => e.preventDefault());
  _toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md]');
    if (btn && _activeTextarea) applyMarkdown(_activeTextarea, btn.dataset.md);
  });
  return _toolbar;
}

function showToolbar(textarea) {
  // Textareas don't participate in the DOM Selection API — use the textarea's
  // own selectionStart/End to detect whether text is selected.
  if (textarea.selectionStart === textarea.selectionEnd) { hideToolbar(); return; }

  _activeTextarea = textarea;
  const tb   = getOrCreateToolbar();
  tb.style.display = 'flex';

  // Position the toolbar centred above the textarea.
  const rect = textarea.getBoundingClientRect();
  const tbW  = 168;
  let   left = rect.left + window.scrollX + rect.width / 2 - tbW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tbW - 8));
  tb.style.left = left + 'px';
  tb.style.top  = Math.max(8, rect.top + window.scrollY - 44) + 'px';
}

function hideToolbar() {
  if (_toolbar) _toolbar.style.display = 'none';
  _activeTextarea = null;
}

function applyMarkdown(textarea, type) {
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const sel   = textarea.value.slice(start, end);
  if (!sel) return;

  let before = '', after = '';
  switch (type) {
    case 'bold':    before = '**';       after = '**';       break;
    case 'italic':  before = '*';        after = '*';        break;
    case 'callout': before = `:::tip\n`; after = `\n:::`;    break;
    case 'link':
      // Link is handled via its own modal — return early here.
      showLinkModal(textarea, start, end, sel);
      return;
    default: return;
  }

  const replacement = before + sel + after;
  textarea.setRangeText(replacement, start, end, 'end');
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  hideToolbar();
  textarea.focus();
}

// ── Link modal ────────────────────────────────────────────────────────────────

function showLinkModal(textarea, start, end, selectedText) {
  hideToolbar();

  // Remove any existing link modal.
  document.getElementById('md-link-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'md-link-modal';
  modal.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9100',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.45)',
  ].join(';');

  modal.innerHTML = `
    <div style="
      background:#1e1e1e;
      border:1px solid #3a3a3a;
      border-radius:10px;
      padding:20px 22px;
      width:340px;
      box-shadow:0 8px 32px rgba(0,0,0,0.6);
      display:flex; flex-direction:column; gap:14px;
    ">
      <div style="font-weight:600;font-size:14px;color:#fff;">Insert link</div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:12px;color:#999;">Text</label>
        <input id="md-link-text" type="text" value="${escapeAttr(selectedText)}" disabled
          style="padding:7px 10px;border:1px solid #3a3a3a;border-radius:6px;
                 background:#2a2a2a;color:#666;font-size:13px;outline:none;cursor:default;">
      </div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:12px;color:#999;">URL</label>
        <input id="md-link-url" type="url" placeholder="https://"
          style="padding:7px 10px;border:1px solid #3a3a3a;border-radius:6px;
                 background:#2a2a2a;color:#fff;font-size:13px;outline:none;">
      </div>

      <div style="display:flex;align-items:center;gap:8px;">
        <input id="md-link-newtab" type="checkbox" checked style="width:14px;height:14px;cursor:pointer;">
        <label for="md-link-newtab" style="font-size:13px;color:#999;cursor:pointer;">
          Open in new tab
        </label>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:2px;">
        <button id="md-link-cancel" style="
          padding:7px 14px;border:1px solid #3a3a3a;border-radius:6px;
          background:none;color:#999;font-size:13px;cursor:pointer;">
          Cancel
        </button>
        <button id="md-link-confirm" style="
          padding:7px 14px;border:none;border-radius:6px;
          background:#4a6cf7;color:#fff;font-size:13px;
          font-weight:500;cursor:pointer;">
          Insert
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const textInput = modal.querySelector('#md-link-text');
  const urlInput  = modal.querySelector('#md-link-url');
  urlInput.focus();

  const confirm = () => {
    const text   = textInput.value.trim() || urlInput.value.trim();
    const url    = urlInput.value.trim();
    const newTab = modal.querySelector('#md-link-newtab').checked;
    if (!url) { urlInput.style.borderColor = 'var(--danger)'; return; }

    // Markdown syntax — new-tab flag stored as a title attribute hint
    // that the export renderer picks up.
    const mdLink = newTab
      ? `[${text}](${url} "_blank")`
      : `[${text}](${url})`;

    textarea.setRangeText(mdLink, start, end, 'end');
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    modal.remove();
    textarea.focus();
  };

  const cancel = () => { modal.remove(); textarea.focus(); };

  modal.querySelector('#md-link-confirm').addEventListener('click', confirm);
  modal.querySelector('#md-link-cancel').addEventListener('click', cancel);
  // Close on backdrop click.
  modal.addEventListener('click', (e) => { if (e.target === modal) cancel(); });
  // Enter to confirm, Escape to cancel.
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

// ── Shared state reference ────────────────────────────────────────────────────

let state        = null;
let recording_id = null;

let _onRenderAll = null;
let _onRegenStep = null;
let _onToast     = null;
let _onAiError   = null;

/**
 * Called once from editor.js main() before any rendering.
 * @param {object} sharedState
 * @param {string} recId
 * @param {object} callbacks — { onRenderAll, onRegenStep, onToast, onAiError }
 */
export function initSteps(sharedState, recId, callbacks) {
  state        = sharedState;
  recording_id = recId;
  _onRenderAll = callbacks.onRenderAll;
  _onRegenStep = callbacks.onRegenStep;
  _onToast     = callbacks.onToast;
  _onAiError   = callbacks.onAiError;
}

// ── Step grouping ─────────────────────────────────────────────────────────────

export function groupSteps(steps) {
  const groups = new Map();
  for (const s of steps) {
    if (!groups.has(s.group_id)) groups.set(s.group_id, []);
    groups.get(s.group_id).push(s);
  }
  return [...groups.values()].map(g => g.sort((a, b) => a.order_in_group - b.order_in_group));
}

// ── Group ordering ────────────────────────────────────────────────────────────

export function applyGroupOrder() {
  const order = state.recording.meta?.group_order;
  if (!order || !order.length) return;
  const orderMap = new Map(order.map((id, i) => [id, i]));
  state.groups.sort((a, b) => {
    const ai = orderMap.has(a[0].group_id) ? orderMap.get(a[0].group_id) : Infinity;
    const bi = orderMap.has(b[0].group_id) ? orderMap.get(b[0].group_id) : Infinity;
    return ai - bi;
  });
}

export async function saveGroupOrder() {
  state.recording.meta = state.recording.meta || {};
  state.recording.meta.group_order = state.groups.map(g => g[0].group_id);
  await putRecording(state.recording);
}

// ── Rail ──────────────────────────────────────────────────────────────────────

export function renderRail() {
  const railTitle = document.getElementById('rail-title');
  const railMeta  = document.getElementById('rail-meta');
  const railSteps = document.getElementById('rail-steps');

  railTitle.textContent = state.recording.title || 'Draft';
  const totalSec = Math.round((state.recording.duration_ms || 0) / 1000);
  railMeta.textContent = `${state.groups.length} steps · ${totalSec}s`;

  railSteps.innerHTML = state.groups.map((group, i) => {
    const primary    = group[0];
    const groupTitle = primary.user_title || primary.ai_title || `Step ${i + 1}`;
    const substeps   = (!primary.manual && group.length > 1)
      ? `<div class="rail-substeps">${
          group.map((s, j) =>
            `<div>${String.fromCharCode(65 + j)}. Click ${escapeHtml((s.click.element_label || '').slice(0, 32))}</div>`
          ).join('')
        }</div>`
      : '';
    return `
      <div class="rail-group" data-group="${i}">
        <span class="rail-group-num">${i + 1}. ${escapeHtml(groupTitle)}</span>
        ${substeps}
      </div>`;
  }).join('');

  for (const el of railSteps.querySelectorAll('.rail-group')) {
    el.addEventListener('click', () => scrollToStep(parseInt(el.dataset.group, 10)));
  }
}

// ── Step cards ────────────────────────────────────────────────────────────────

export function renderSteps() {
  const container = document.getElementById('steps-container');
  container.innerHTML = state.groups.map((group, i) => renderStepCard(group, i + 1)).join('');

  for (const card of container.querySelectorAll('.step-card')) {
    const idx        = parseInt(card.dataset.group, 10);
    const titleInput = card.querySelector('.step-card-title-input');
    const descInput  = card.querySelector('.step-description-input');

    titleInput.addEventListener('change', async () => {
      const primary = state.groups[idx][0];
      primary.user_title = titleInput.value || null;
      await putStep(primary);
      renderRail();
    });

    descInput.addEventListener('change', async () => {
      const primary = state.groups[idx][0];
      primary.user_description = descInput.value || null;
      await putStep(primary);
    });

    // Wire visibility toggles.
    for (const btn of card.querySelectorAll('[data-vis-toggle]')) {
      btn.addEventListener('click', () => handleVisToggle(idx, btn.dataset.visField));
    }

    // Wire floating markdown toolbar on description textarea.
    const descTA = card.querySelector('.step-description-input');
    if (descTA) {
      descTA.addEventListener('mouseup', () => showToolbar(descTA));
      descTA.addEventListener('keyup',   () => showToolbar(descTA));
    }

    // Wire image upload for manual steps.
    const uploadInput = card.querySelector('.manual-image-input');
    if (uploadInput) {
      uploadInput.addEventListener('change', (e) => handleImageUpload(e, idx));
    }

    // Wire remove-image button.
    const removeBtn = card.querySelector('.manual-image-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => handleImageRemove(idx));
    }

    // Wire drag-and-drop on the upload zone.
    const zone = card.querySelector('.manual-upload-zone');
    if (zone) {
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) processImageFile(file, idx);
      });
    }
  }
}

export function renderStepCard(group, stepNumber) {
  const primary    = group[0];
  const isManual   = !!primary.manual;
  const totalSteps = state.groups.length;
  const idx        = stepNumber - 1;
  const hidden     = primary.hidden || {};

  const title = primary.user_title || primary.ai_title ||
    (isManual ? 'New step' : `Click ${primary.click.element_label || ''}`);
  const description   = primary.user_description || primary.ai_description || '';
  const screenshotUrl = state.screenshotUrls.get(primary.screenshot_blob_id) || '';

  const substepsHtml = (!isManual && group.length > 1) ? `
    <div class="substeps-list">
      ${group.map((s, i) => `
        <div class="substep">
          <span class="substep-num">${i + 1}</span>
          <span>${escapeHtml(s.user_description || s.ai_description || `Click ${s.click.element_label || ''}`)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  const moveUpStyle   = idx === 0              ? ' style="visibility:hidden"' : '';
  const moveDownStyle = idx === totalSteps - 1 ? ' style="visibility:hidden"' : '';

  // Eye button — toggles a section's visibility in the export.
  const eyeBtn = (field, label) => {
    const off = !!hidden[field];
    return `<button class="icon-btn vis-toggle${off ? ' vis-off' : ''}"
      title="${off ? 'Show' : 'Hide'} ${label} in export"
      data-vis-toggle="${idx}" data-vis-field="${field}">${off ? '🙈' : '👁'}</button>`;
  };

  // Screenshot / image section — only rendered when there is something to show.
  let screenshotHtml = '';
  if (isManual) {
    screenshotHtml = `
      <div class="step-section${hidden.image ? ' section-hidden' : ''}">
        <div class="section-label-row">
          <span class="section-label">Image</span>
          ${eyeBtn('image', 'image')}
        </div>
        ${renderManualImageArea(primary, screenshotUrl)}
      </div>`;
  } else if (screenshotUrl) {
    screenshotHtml = `
      <div class="step-section${hidden.image ? ' section-hidden' : ''}">
        <div class="section-label-row">
          <span class="section-label">Screenshot</span>
          ${eyeBtn('image', 'screenshot')}
        </div>
        <div class="step-card-screenshot">
          <div style="position:relative;" data-annotations-container="${idx}">
            <img src="${escapeAttr(screenshotUrl)}" alt="Step screenshot" id="step-img-${idx}">
            <div class="annotations-overlay" style="position:absolute;inset:0;pointer-events:none;"></div>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="step-card" data-group="${idx}">
      <div class="step-card-header${hidden.title ? ' section-hidden' : ''}">
        <div class="step-card-num">${stepNumber}</div>
        <input class="step-card-title-input" value="${escapeAttr(title)}">
        <div class="step-card-actions">
          <button class="icon-btn step-move-btn" title="Move up"   data-move-up="${idx}"${moveUpStyle}>↑</button>
          <button class="icon-btn step-move-btn" title="Move down" data-move-down="${idx}"${moveDownStyle}>↓</button>
          ${eyeBtn('title', 'title')}
          ${isManual ? '' : `<button class="icon-btn" title="Regenerate with AI" data-regen="${idx}">✨</button>`}
          <button class="icon-btn" title="Delete this step" data-delete="${idx}">🗑</button>
        </div>
      </div>
      <div class="step-section${hidden.description ? ' section-hidden' : ''}">
        <div class="section-label-row">
          <span class="section-label">Description</span>
          ${eyeBtn('description', 'description')}
        </div>
        <textarea class="step-description-input" placeholder="Add a description...">${escapeHtml(description)}</textarea>
      </div>
      ${screenshotHtml}
      ${substepsHtml}
    </div>`;
}

// ── Manual image area ─────────────────────────────────────────────────────────

function renderManualImageArea(step, imageUrl) {
  // State A — image already uploaded: show preview + remove button.
  if (imageUrl) {
    return `
      <div class="step-card-screenshot step-card-screenshot--manual">
        <div class="manual-image-preview">
          <img src="${escapeAttr(imageUrl)}" alt="Step image">
          <button class="manual-image-remove icon-btn" title="Remove image">✕</button>
        </div>
      </div>`;
  }

  // State B — no image yet: show upload zone.
  return `
    <div class="step-card-screenshot step-card-screenshot--manual">
      <label class="manual-upload-zone">
        <span class="manual-upload-icon">🖼</span>
        <span class="manual-upload-label">Click to upload or drag &amp; drop</span>
        <span class="manual-upload-hint">PNG, JPG, WebP or GIF · max 5 MB · optional</span>
        <input
          class="manual-image-input"
          type="file"
          accept="${ALLOWED_EXTENSIONS}"
          style="display:none;"
        >
        <div class="manual-upload-error" style="display:none;"></div>
      </label>
    </div>`;
}

// ── Image upload logic ────────────────────────────────────────────────────────

function handleImageUpload(e, idx) {
  const file = e.target.files[0];
  if (!file) return;
  // Reset the input so the same file can be re-selected after a remove.
  e.target.value = '';
  processImageFile(file, idx);
}

async function processImageFile(file, idx) {
  const card = document.querySelector(`.step-card[data-group="${idx}"]`);
  const errorEl = card?.querySelector('.manual-upload-error');

  // ── Validation ──────────────────────────────────────────────────────────────
  const validationError = validateImageFile(file);
  if (validationError) {
    if (errorEl) {
      errorEl.textContent = validationError;
      errorEl.style.display = 'block';
    }
    return;
  }
  if (errorEl) errorEl.style.display = 'none';

  // ── Store blob in IndexedDB ─────────────────────────────────────────────────
  const step = state.groups[idx][0];

  // Remove old blob if replacing.
  if (step.screenshot_blob_id) {
    await deleteBlob(step.screenshot_blob_id);
    URL.revokeObjectURL(state.screenshotUrls.get(step.screenshot_blob_id));
    state.screenshotUrls.delete(step.screenshot_blob_id);
  }

  const blobId = uuid();
  await putBlob(blobId, file.type, file);

  // Cache the object URL so the preview renders without another DB read.
  state.screenshotUrls.set(blobId, URL.createObjectURL(file));

  step.screenshot_blob_id = blobId;
  await putStep(step);

  // Re-render just the steps (not the full renderAll — avoids scroll jump).
  renderSteps();
  renderAnnotationsForAllCards();
  _onToast('Image uploaded');
}

async function handleImageRemove(idx) {
  const step = state.groups[idx][0];
  if (!step.screenshot_blob_id) return;

  await deleteBlob(step.screenshot_blob_id);
  URL.revokeObjectURL(state.screenshotUrls.get(step.screenshot_blob_id));
  state.screenshotUrls.delete(step.screenshot_blob_id);

  step.screenshot_blob_id = null;
  await putStep(step);

  renderSteps();
  renderAnnotationsForAllCards();
  _onToast('Image removed');
}

/**
 * Validate a File against allowed types and size limit.
 * @param {File} file
 * @returns {string|null} error message, or null if valid
 */
function validateImageFile(file) {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return `Unsupported format "${file.type || file.name.split('.').pop()}". Please use PNG, JPG, WebP, or GIF.`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    return `Image is ${sizeMb} MB — maximum size is 5 MB.`;
  }
  return null;
}

// ── Annotation overlays ───────────────────────────────────────────────────────

export function renderAnnotationsForAllCards() {
  for (const img of document.querySelectorAll('.step-card-screenshot img')) {
    // Skip manual step preview images — they have no annotations.
    if (img.closest('.manual-image-preview')) continue;

    const apply = () => {
      if (!img.naturalWidth) return;
      const container = img.closest('[data-annotations-container]');
      if (!container) return;
      const idx   = parseInt(container.dataset.annotationsContainer, 10);
      const group = state.groups[idx];
      if (!group) return;
      const overlay = container.querySelector('.annotations-overlay');
      if (!overlay) return;

      const clicks = group
        .filter(s => s.click.bounding_box)
        .map(s => {
          const dpr = s.click.device_pixel_ratio || 1;
          const b   = s.click.bounding_box;
          return {
            bounding_box: { x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr },
            label:        s.user_title || s.click.element_label || '',
            show_callout: s.click.label_visible === false,
          };
        });

      overlay.innerHTML = renderAnnotationsSvg({ width: img.naturalWidth, height: img.naturalHeight, clicks });
      const svg = overlay.querySelector('svg');
      if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block'; }
    };
    if (img.complete) apply(); else img.addEventListener('load', apply);
  }
}

// ── Visibility toggle ────────────────────────────────────────────────────────

async function handleVisToggle(idx, field) {
  const primary = state.groups[idx][0];
  primary.hidden = primary.hidden || {};
  primary.hidden[field] = !primary.hidden[field];
  await putStep(primary);
  renderSteps();
  renderAnnotationsForAllCards();
}

// ── Action handlers ───────────────────────────────────────────────────────────

export function bindStepActions() {
  // Hide the markdown toolbar on click outside a description textarea.
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.step-description-input') &&
        !e.target.closest('.md-toolbar')) {
      hideToolbar();
    }
  });

  // ── Add manual step ───────────────────────────────────────────────────────
  document.getElementById('add-step-btn').addEventListener('click', async () => {
    const groupId = uuid();
    const stepId  = uuid();
    const now     = new Date().toISOString();

    const newStep = {
      id:                 stepId,
      recording_id,
      group_id:           groupId,
      order_in_group:     0,
      manual:             true,
      click:              { element_label: '', bounding_box: null, url: '', device_pixel_ratio: 1, label_visible: true },
      screenshot_blob_id: null,
      video_timestamp_ms: null,
      ai_title:           null,
      ai_description:     null,
      user_title:         null,
      user_description:   null,
      created_at:         now,
    };

    await putStep(newStep);

    state.steps.push(newStep);
    state.groups = groupSteps(state.steps);

    state.recording.meta = state.recording.meta || {};
    const existingOrder  = state.recording.meta.group_order || state.groups.map(g => g[0].group_id);
    state.recording.meta.group_order = [...existingOrder.filter(id => id !== groupId), groupId];
    applyGroupOrder();

    state.recording.step_ids = state.steps.map(s => s.id);
    await putRecording(state.recording);

    _onRenderAll();
    renderAnnotationsForAllCards();
    scrollToStep(state.groups.length - 1);
    _onToast('Manual step added');
  });

  // ── Delegated step-card actions ───────────────────────────────────────────
  document.getElementById('steps-container').addEventListener('click', async (e) => {

    // Move up
    const moveUpBtn = e.target.closest('[data-move-up]');
    if (moveUpBtn) {
      const idx = parseInt(moveUpBtn.dataset.moveUp, 10);
      if (idx === 0) return;
      [state.groups[idx - 1], state.groups[idx]] = [state.groups[idx], state.groups[idx - 1]];
      await saveGroupOrder();
      _onRenderAll();
      renderAnnotationsForAllCards();
      return;
    }

    // Move down
    const moveDownBtn = e.target.closest('[data-move-down]');
    if (moveDownBtn) {
      const idx = parseInt(moveDownBtn.dataset.moveDown, 10);
      if (idx === state.groups.length - 1) return;
      [state.groups[idx], state.groups[idx + 1]] = [state.groups[idx + 1], state.groups[idx]];
      await saveGroupOrder();
      _onRenderAll();
      renderAnnotationsForAllCards();
      return;
    }

    // Regenerate with AI
    const regenBtn = e.target.closest('[data-regen]');
    if (regenBtn) {
      const idx   = parseInt(regenBtn.dataset.regen, 10);
      const group = state.groups[idx];
      try {
        _onToast('Regenerating...');
        for (const step of group) await _onRegenStep(step);
        renderSteps();
        renderRail();
        renderAnnotationsForAllCards();
        _onToast('Step regenerated');
      } catch (err) { _onAiError(err); }
      return;
    }

    // Delete
    const deleteBtn = e.target.closest('[data-delete]');
    if (deleteBtn) {
      const idx   = parseInt(deleteBtn.dataset.delete, 10);
      const group = state.groups[idx];
      const label = group[0].user_title || group[0].ai_title || `Step ${idx + 1}`;
      if (!confirm(
        `Delete "${label}"? This removes ${group.length === 1 ? 'this step' : `${group.length} sub-steps`} and cannot be undone.`
      )) return;

      for (const step of group) {
        await deleteStep(step.id);
        if (step.screenshot_blob_id) {
          await deleteBlob(step.screenshot_blob_id);
          URL.revokeObjectURL(state.screenshotUrls.get(step.screenshot_blob_id));
          state.screenshotUrls.delete(step.screenshot_blob_id);
        }
      }

      const deletedGroupId = group[0].group_id;
      state.steps  = state.steps.filter(s => s.group_id !== deletedGroupId);
      state.groups = groupSteps(state.steps);
      applyGroupOrder();

      if (state.recording.meta?.group_order) {
        state.recording.meta.group_order =
          state.recording.meta.group_order.filter(id => id !== deletedGroupId);
      }
      state.recording.step_ids = state.steps.map(s => s.id);
      await putRecording(state.recording);

      _onRenderAll();
      renderAnnotationsForAllCards();
      _onToast('Step deleted');
      return;
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function scrollToStep(idx) {
  const el = document.querySelectorAll('.step-card')[idx];
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }