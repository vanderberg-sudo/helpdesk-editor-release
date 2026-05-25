// editor.js — Top-level editor controller.
//
// Responsibilities:
//   - Boot: load recording + steps from IndexedDB, resolve screenshot URLs
//   - Maintain the shared `state` object
//   - Coordinate rendering (renderAll calls renderTopbar + renderRail + renderSteps)
//   - Wire topbar / metadata / AI / export / publish / settings UI
//   - Delegate step rendering, ordering, and actions → editor-steps.js
//   - Delegate publish UI overlays → editor-publish-ui.js

import {
  getRecording, getStepsForRecording, putStep, putRecording, getBlob,
} from '../src/db.js';
import {
  generateStepDescription, generateGroupTitle,
  generateArticleTitle, generateArticleDescription, generateArticleTags,
} from './ai.js';
import { NoApiKeyError, getApiKey, setApiKey } from './anthropic.js';
import {
  exportStandalone, exportBundle, exportEmbedSnippet, exportWordPress, exportAstro,
} from './export.js';
import { publishArticle, getSharedSecret, setSharedSecret } from './upload.js';
import { makeZip } from './zip.js';
import {
  initSteps, groupSteps, applyGroupOrder,
  renderRail, renderSteps, renderAnnotationsForAllCards, bindStepActions,
} from './editor-steps.js';
import {
  showPublishSuccessBanner, showPublishErrors,
  showProgressOverlay, showFallbackClipboardModal,
} from './editor-publish-ui.js';

// ── URL params ────────────────────────────────────────────────────────────────

const params       = new URLSearchParams(location.search);
const recording_id = params.get('recording');
const settingsMode = params.get('settings');

// ── Shared state ──────────────────────────────────────────────────────────────
// Single source of truth for both this module and editor-steps.js.

const state = {
  recording:      null,
  steps:          [],
  groups:         [],          // array of step arrays, one per group
  screenshotUrls: new Map(),   // blob_id → object URL
};

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  bindSettingsUi();

  if (settingsMode) {
    document.getElementById('settings-modal').style.display = 'flex';
    await populateSettings();
    return;
  }

  if (!recording_id) {
    document.body.innerHTML = '<div style="padding:40px;">No recording specified.</div>';
    return;
  }

  state.recording = await getRecording(recording_id);
  if (!state.recording) {
    document.body.innerHTML = '<div style="padding:40px;">Recording not found.</div>';
    return;
  }

  state.steps = await getStepsForRecording(recording_id);
  state.steps.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.groups = groupSteps(state.steps);

  // Hand the shared state + callbacks to editor-steps.js.
  initSteps(state, recording_id, {
    onRenderAll:  renderAll,
    onRegenStep:  regenerateStep,
    onToast:      toast,
    onAiError:    handleAiError,
  });

  applyGroupOrder();

  // Resolve screenshot blob URLs — skip manual steps (screenshot_blob_id is null).
  for (const step of state.steps) {
    if (!step.screenshot_blob_id) continue;
    if (!state.screenshotUrls.has(step.screenshot_blob_id)) {
      const blob = await getBlob(step.screenshot_blob_id);
      if (blob) state.screenshotUrls.set(step.screenshot_blob_id, URL.createObjectURL(blob));
    }
  }

  await loadVideoWhenReady();

  renderAll();
  bindUi();

  if (await getApiKey()) runAiGeneration();
}

// ── Video loader ──────────────────────────────────────────────────────────────

async function loadVideoWhenReady() {
  const sectionEl = document.getElementById('video-section');
  sectionEl.style.display = 'block';

  // Render the section header (with toggle) + a loading placeholder.
  // We always build this in JS so the toggle is never wiped by innerHTML.
  const renderVideoSection = (bodyHtml) => {
    const hidden = !!state.recording.meta?.hide_video;
    sectionEl.innerHTML = `
      <div class="section-label-row">
        <span class="section-label">Video</span>
        <button class="icon-btn vis-toggle${hidden ? ' vis-off' : ''}"
          id="video-vis-toggle"
          title="${hidden ? 'Show video in export' : 'Hide video in export'}"
          >${hidden ? '🙈' : '👁'}</button>
      </div>
      ${bodyHtml}`;

    // Re-wire the toggle each time (innerHTML replaced the old listener).
    document.getElementById('video-vis-toggle').addEventListener('click', async () => {
      state.recording.meta = state.recording.meta || {};
      state.recording.meta.hide_video = !state.recording.meta.hide_video;
      await putRecording(state.recording);
      const videoEl = sectionEl.querySelector('video');
      renderVideoSection(videoEl ? videoEl.outerHTML : '');
      if (videoEl) {
        // Preserve the src after re-render.
        sectionEl.querySelector('video').src = videoEl.src;
      }
    });

    // Dim the video element when hidden.
    const videoEl = sectionEl.querySelector('video');
    if (videoEl) videoEl.style.opacity = hidden ? '0.35' : '1';
  };

  renderVideoSection('<div style="padding:40px;text-align:center;color:var(--text-secondary);background:var(--bg-secondary);border-radius:8px;">Processing video…</div>');

  for (let attempt = 0; attempt < 30; attempt++) {
    const fresh = await getRecording(recording_id);
    if (fresh && fresh.video_blob_id) {
      state.recording = fresh;
      const blob = await getBlob(fresh.video_blob_id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        renderVideoSection('<video controls id="video-player" style="width:100%;border-radius:8px;"></video>');
        sectionEl.querySelector('video').src = url;
        return;
      }
    }
    await sleep(1000);
  }
  sectionEl.style.display = 'none';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAll() {
  renderTopbar();
  renderRail();
  renderSteps();
}

function renderTopbar() {
  document.getElementById('article-title-crumb').textContent =
    state.recording.title || 'Untitled recording';
  document.getElementById('article-title').value = state.recording.title || '';
  document.getElementById('created-at').textContent =
    new Date(state.recording.created_at).toLocaleString();

  const meta = state.recording.meta || {};
  const setIfEmpty = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = value || '';
  };
  setIfEmpty('meta-description', meta.description);
  setIfEmpty('meta-category',    meta.category);
  const effectiveSlug = (meta.slug && meta.slug !== 'article')
    ? meta.slug : slugify(state.recording.title || '');
  setIfEmpty('meta-slug', effectiveSlug);
  setIfEmpty('meta-tags', Array.isArray(meta.tags) ? meta.tags.join(', ') : (meta.tags || ''));

  const conclusionEl = document.getElementById('article-conclusion');
  if (conclusionEl && meta.conclusion) conclusionEl.value = meta.conclusion;
}

// ── UI bindings ───────────────────────────────────────────────────────────────

function bindUi() {
  // Article title
  document.getElementById('article-title').addEventListener('change', async (e) => {
    state.recording.title = e.target.value;
    const slugInput = document.getElementById('meta-slug');
    if (slugInput && !slugInput.value.trim()) {
      slugInput.value = slugify(e.target.value);
      state.recording.meta = state.recording.meta || {};
      state.recording.meta.slug = slugInput.value;
    }
    await putRecording(state.recording);
    renderTopbar();
    renderRail();
  });

  // Metadata fields
  bindMetaField('meta-description', 'description');
  bindMetaField('meta-category',    'category', (v) => v.trim().toLowerCase());
  bindMetaField('meta-slug',        'slug',     (v) => slugify(v));
  bindMetaField('meta-tags',        'tags',     (v) => v.split(',').map(t => t.trim()).filter(Boolean));

  // Conclusion
  const conclusionEl = document.getElementById('article-conclusion');
  if (conclusionEl) {
    conclusionEl.addEventListener('input', async () => {
      state.recording.meta = state.recording.meta || {};
      state.recording.meta.conclusion = conclusionEl.value;
      await putRecording(state.recording);
    });
  }

  // AI — regenerate title
  document.getElementById('regen-title-btn').addEventListener('click', async () => {
    const titles = state.groups.map(g =>
      g[0].user_title || g[0].ai_title || `Click ${g[0].click.element_label || ''}`
    );
    try {
      toast('Generating title...');
      const newTitle = await generateArticleTitle(titles, state.recording.url_origin);
      state.recording.title = newTitle;
      await putRecording(state.recording);
      renderTopbar();
      renderRail();
      toast('Title regenerated');
    } catch (err) { handleAiError(err); }
  });

  // AI — rewrite all
  document.getElementById('regen-all-btn').addEventListener('click', async () => {
    const btn           = document.getElementById('regen-all-btn');
    const originalLabel = btn.innerHTML;
    const allSteps      = state.groups.flat();
    const stepTotal     = allSteps.length;
    const grandTotal    = stepTotal + 3;  // steps + title + description + tags

    const otherButtons = Array.from(document.querySelectorAll('[data-regen], #regen-title-btn, #regen-all-btn'));
    for (const b of otherButtons) b.disabled = true;
    btn.classList.add('is-running');

    let completed = 0;
    const updateLabel = (label) => {
      btn.innerHTML = `<span class="spinner"></span> ${label} (${completed} of ${grandTotal})`;
    };
    updateLabel('Rewriting…');

    try {
      // Phase 1 — step descriptions (parallel, max 4 workers)
      const CONCURRENCY = 4;
      const queue = allSteps.slice();
      let firstError = null;

      async function worker() {
        while (queue.length > 0 && !firstError) {
          const step = queue.shift();
          try { await regenerateStep(step); }
          catch (err) { if (!firstError) firstError = err; throw err; }
          completed += 1;
          updateLabel('Rewriting steps…');
        }
      }
      await Promise.allSettled(
        Array.from({ length: Math.min(CONCURRENCY, stepTotal) }, () => worker())
      );
      if (firstError) throw firstError;

      renderSteps();
      renderRail();
      renderAnnotationsForAllCards();

      const stepTitles = state.groups.map(g =>
        g[0].user_title || g[0].ai_title || `Step ${g[0].order_in_group}`
      );

      // Phase 2 — article title
      updateLabel('Rewriting title…');
      const newTitle = await generateArticleTitle(stepTitles, state.recording.url_origin);
      state.recording.title = newTitle;
      completed += 1;

      // Phase 3 — SEO description
      updateLabel('Writing description…');
      const newDesc = await generateArticleDescription(newTitle, stepTitles, state.recording.url_origin);
      state.recording.meta = state.recording.meta || {};
      state.recording.meta.description = newDesc;
      completed += 1;

      // Phase 4 — tags
      updateLabel('Generating tags…');
      const rawTags    = await generateArticleTags(newTitle, stepTitles, state.recording.url_origin);
      const parsedTags = rawTags.split(',').map(t => t.trim()).filter(Boolean);
      state.recording.meta.tags = parsedTags;
      completed += 1;

      const newSlug = slugify(newTitle);
      state.recording.meta.slug = newSlug;
      await putRecording(state.recording);

      renderTopbar();
      renderRail();
      const descEl = document.getElementById('meta-description');
      if (descEl) descEl.value = newDesc;
      const tagsEl = document.getElementById('meta-tags');
      if (tagsEl) tagsEl.value = parsedTags.join(', ');
      const slugEl = document.getElementById('meta-slug');
      if (slugEl) slugEl.value = newSlug;

      toast(`Rewrote ${stepTotal} step${stepTotal === 1 ? '' : 's'} + title, description & tags`);
    } catch (err) {
      renderSteps();
      renderRail();
      renderAnnotationsForAllCards();
      handleAiError(err);
    } finally {
      btn.classList.remove('is-running');
      btn.innerHTML = originalLabel;
      for (const b of otherButtons) b.disabled = false;
    }
  });

  // Step actions (add / move / regen / delete) — delegated to editor-steps.js
  bindStepActions();

  // Preview
  document.getElementById('preview-btn').addEventListener('click', async () => {
    try {
      toast('Building preview...');
      const html = await exportStandalone(state.recording, state.groups);
      const blob = new Blob([html], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      console.error(err);
      toast('Preview failed: ' + err.message);
    }
  });

  // Manage
  document.getElementById('manage-btn').addEventListener('click', () => {
    window.open(chrome.runtime.getURL('editor/manage.html'), '_blank');
  });

  // Publish
  document.getElementById('publish-btn').addEventListener('click', async () => {
    const btn           = document.getElementById('publish-btn');
    const originalLabel = btn.textContent;
    btn.disabled    = true;
    btn.textContent = 'Publishing…';

    try {
      const total = state.groups.length;
      const result = await publishArticle(state.recording, state.groups, {
        onProgress: (done) => { btn.textContent = `Publishing… (${done}/${total})`; },
      });

      if (result.status === 'success') {
        showPublishSuccessBanner(result.url);
      } else if (result.status === 'conflict') {
        toast('Publish cancelled.');
      } else if (result.status === 'error') {
        showPublishErrors(result.errors);
      } else {
        toast('Publish failed: ' + (result.message || 'Unknown error'));
        console.error('Publish fatal error:', result.message);
      }
    } catch (err) {
      console.error('Unexpected publish error', err);
      toast('Publish failed: ' + err.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = originalLabel;
    }
  });

  // Export modal
  document.getElementById('export-btn').addEventListener('click', () => {
    document.getElementById('export-modal').style.display = 'flex';
  });
  document.getElementById('close-export-btn').addEventListener('click', () => {
    document.getElementById('export-modal').style.display = 'none';
  });
  for (const opt of document.querySelectorAll('.export-option')) {
    opt.addEventListener('click', () => doExport(opt.dataset.format));
  }

  // Embed modal
  document.getElementById('close-embed-btn').addEventListener('click', () => {
    document.getElementById('embed-modal').style.display = 'none';
  });
  document.getElementById('copy-embed-btn').addEventListener('click', () => {
    const snippet = document.getElementById('embed-snippet');
    snippet.select();
    document.execCommand('copy');
    toast('Snippet copied');
  });

  renderAnnotationsForAllCards();
}

// ── Settings ──────────────────────────────────────────────────────────────────

function bindSettingsUi() {
  const closeBtn = document.getElementById('close-settings-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('settings-modal').style.display = 'none';
      if (!recording_id) window.close();
    });
  }
  const saveBtn = document.getElementById('save-api-key-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const key    = document.getElementById('api-key-input').value.trim();
      const secret = document.getElementById('helpdesk-secret-input').value.trim();
      try {
        await setApiKey(key);
        await setSharedSecret(secret);
        toast((key || secret) ? 'Settings saved' : 'Settings cleared');
        document.getElementById('settings-modal').style.display = 'none';
        if (!recording_id) setTimeout(() => window.close(), 500);
      } catch (err) {
        console.error('Failed to save settings', err);
        toast('Failed to save: ' + err.message);
      }
    });
  }
}

async function populateSettings() {
  const key    = await getApiKey();
  if (key)    document.getElementById('api-key-input').value = key;
  const secret = await getSharedSecret();
  if (secret) document.getElementById('helpdesk-secret-input').value = secret;
}

// ── AI ────────────────────────────────────────────────────────────────────────

async function regenerateStep(step) {
  // Manual steps have no screenshot — pass null so the AI works with text only.
  const blob = step.screenshot_blob_id ? await getBlob(step.screenshot_blob_id) : null;
  const desc = await generateStepDescription(step, blob, state.recording.url_origin);
  step.ai_description = desc;
  if (!step.ai_title) {
    step.ai_title = await generateGroupTitle([step], state.recording.url_origin);
  }
  await putStep(step);
  return step;
}

async function runAiGeneration() {
  let dirty = false;

  for (const group of state.groups) {
    const primary = group[0];

    if (!primary.ai_description) {
      try {
        const blob = primary.screenshot_blob_id ? await getBlob(primary.screenshot_blob_id) : null;
        primary.ai_description = await generateStepDescription(primary, blob, state.recording.url_origin);
        await putStep(primary);
        dirty = true;
      } catch (err) {
        if (err instanceof NoApiKeyError) return;
        console.error('AI step description failed', err);
      }
    }

    if (!primary.ai_title) {
      try {
        primary.ai_title = await generateGroupTitle(group, state.recording.url_origin);
        await putStep(primary);
        dirty = true;
      } catch (err) {
        if (err instanceof NoApiKeyError) return;
        console.error('AI group title failed', err);
      }
    }
  }

  if (!state.recording.title) {
    try {
      const titles = state.groups.map(g => g[0].ai_title || `Step ${g[0].order_in_group}`);
      state.recording.title = await generateArticleTitle(titles, state.recording.url_origin);
      await putRecording(state.recording);
      dirty = true;
    } catch (err) {
      if (!(err instanceof NoApiKeyError)) console.error('AI article title failed', err);
    }
  }

  if (dirty) {
    renderAll();
    renderAnnotationsForAllCards();
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

async function doExport(format) {
  document.getElementById('export-modal').style.display = 'none';
  try {
    if (format === 'astro') {
      await doAstroExport();
    } else if (format === 'wordpress') {
      await doWordPressExport();
    } else if (format === 'standalone') {
      toast('Building standalone HTML...');
      const html = await exportStandalone(state.recording, state.groups);
      downloadBlob(new Blob([html], { type: 'text/html' }), articleSlug() + '.html');
      toast('Downloaded');
    } else if (format === 'bundle') {
      toast('Building bundle...');
      const { files, slug: s } = await exportBundle(state.recording, state.groups);
      const prefixedFiles = new Map();
      for (const [path, data] of files.entries()) prefixedFiles.set(`${s}/${path}`, data);
      const zipBlob = await makeZip(prefixedFiles);
      downloadBlob(zipBlob, s + '.zip');
      toast('Bundle downloaded');
    } else if (format === 'embed') {
      const snippet = exportEmbedSnippet(state.recording, 'https://YOUR-HOST.example.com');
      document.getElementById('embed-snippet').value = snippet;
      document.getElementById('embed-modal').style.display = 'flex';
    }
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + err.message);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function doAstroExport() {
  const overlay = showProgressOverlay('Building help center ZIP…', state.groups.length);
  let result;
  try {
    result = await exportAstro(state.recording, state.groups, {
      includeVideo: true,
      onProgress:   (done, total) => overlay.update(done, total),
    });
  } catch (err) { overlay.close(); throw err; }
  overlay.close();

  if (result.validationErrors && result.validationErrors.length > 0) {
    const metaDetails = document.getElementById('article-meta');
    if (metaDetails) metaDetails.open = true;
    const fieldNames = { title: 'Article title', description: 'Description', category: 'Category', slug: 'Slug' };
    const lines = result.validationErrors.map(e => `• ${fieldNames[e.field] || e.field}: ${e.message}`);
    alert('Cannot export to Astro — these fields need attention:\n\n' + lines.join('\n') + '\n\nThe metadata section has been opened for you.');
    metaDetails?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  downloadBlob(result.zipBlob, `${result.slug}.zip`);
  toast(`Downloaded ${result.slug}.zip (${(result.zipBlob.size / 1024).toFixed(0)} KB)`);
}

async function doWordPressExport() {
  const overlay = showProgressOverlay('Building WordPress HTML…', state.groups.length);
  let html;
  try {
    html = await exportWordPress(state.recording, state.groups, {
      includeVideo: true,
      onProgress:   (done, total) => overlay.update(done, total),
    });
  } catch (err) { overlay.close(); throw err; }

  const sizeMb = (html.length / 1024 / 1024).toFixed(1);
  if (html.length > 10 * 1024 * 1024) {
    overlay.close();
    if (!confirm(`The HTML is ${sizeMb} MB. WordPress's editor may struggle with very large pastes. Continue?`)) return;
  } else {
    overlay.close();
  }

  try {
    await navigator.clipboard.writeText(html);
    toast(`Copied ${sizeMb} MB of HTML — paste into WordPress's Code editor`);
  } catch (err) {
    console.error('Clipboard write failed', err);
    showFallbackClipboardModal(html);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function articleSlug() {
  return (state.recording.title || 'article')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'article';
}

const SLUG_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'by', 'with', 'from', 'is', 'it', 'as', 'up', 'be', 'its',
]);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(w => w && !SLUG_STOP_WORDS.has(w))
    .join('-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'article';
}

function bindMetaField(elementId, key, transform) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.addEventListener('input', async () => {
    state.recording.meta = state.recording.meta || {};
    state.recording.meta[key] = transform ? transform(el.value) : el.value;
    await putRecording(state.recording);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2500);
}

function handleAiError(err) {
  if (err instanceof NoApiKeyError) {
    toast('Add your API key in settings first');
    document.getElementById('settings-modal').style.display = 'flex';
  } else {
    toast('AI error: ' + err.message);
  }
}

main();