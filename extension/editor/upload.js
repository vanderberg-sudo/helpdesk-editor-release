// upload.js — "Publish to Help Center" feature.
//
// Responsibilities:
//   - Read / write the shared secret from chrome.storage.local
//   - Build the article ZIP (delegates entirely to exportAstro)
//   - POST the ZIP to the Cloudflare Worker upload endpoint
//   - Handle the 409 "already exists" conflict with a confirmation dialog
//   - Return a structured result the caller can use to show success / errors
//
// Nothing in this file touches the DOM directly.  The editor wires up the
// button and displays results using the helpers exported below.

import { exportAstro } from './export.js';

// ── Storage keys ──────────────────────────────────────────────────────────────

const STORAGE_KEY_SECRET          = 'helpdesk_shared_secret';
const STORAGE_KEY_PUBLISHED       = 'helpdesk_published_slugs';
const STORAGE_KEY_PENDING_PUBLISH = 'helpdesk_pending_publishes';

/**
 * Record a slug as published in chrome.storage.local.
 * Used by the Manage screen to filter drafts without waiting for
 * content-index.json to reflect the latest build.
 * The list grows forever — slugs are never removed (tiny footprint).
 * @param {string} slug
 * @returns {Promise<void>}
 */
async function recordPublishedSlug(slug, recordingId) {
  const result = await chrome.storage.local.get(STORAGE_KEY_PUBLISHED);
  const existing = result[STORAGE_KEY_PUBLISHED] || [];
  const alreadyStored = existing.some(e =>
    (typeof e === 'object' ? e.slug : e) === slug
  );
  if (!alreadyStored) {
    existing.push({ slug, recordingId });
    await chrome.storage.local.set({ [STORAGE_KEY_PUBLISHED]: existing });
  }
}

/**
 * Retrieve all published entries from this browser.
 * Returns { slug, recordingId } objects.
 * Handles legacy entries stored as plain strings (recordingId will be null).
 * @returns {Promise<Array<{ slug: string, recordingId: string|null }>>}
 */
export async function getPublishedEntries() {
  const result = await chrome.storage.local.get(STORAGE_KEY_PUBLISHED);
  const raw = result[STORAGE_KEY_PUBLISHED] || [];
  return raw.map(e => typeof e === 'object' ? e : { slug: e, recordingId: null });
}

/**
 * Record rich metadata for an article that was just published but whose
 * Cloudflare Pages build is still in progress.  The Manage screen reads
 * this to show a "pending publishing" row until content-index.json confirms
 * the article is live.
 *
 * Shape stored per entry:
 *   { slug, category, title, description, recordingId, publishedAt }
 *
 * @param {{ slug: string, category: string, title: string, description: string, recordingId: string }} entry
 * @returns {Promise<void>}
 */
export async function recordPendingPublish(entry) {
  const result = await chrome.storage.local.get(STORAGE_KEY_PENDING_PUBLISH);
  const existing = result[STORAGE_KEY_PENDING_PUBLISH] || [];
  // Replace any prior entry for the same slug (re-publish / update case).
  const filtered = existing.filter(e => e.slug !== entry.slug);
  filtered.push({ ...entry, publishedAt: Date.now() });
  await chrome.storage.local.set({ [STORAGE_KEY_PENDING_PUBLISH]: filtered });
}

/**
 * Retrieve all pending-publish entries.
 * @returns {Promise<Array<{ slug, category, title, description, publishedAt }>>}
 */
export async function getPendingPublishes() {
  const result = await chrome.storage.local.get(STORAGE_KEY_PENDING_PUBLISH);
  return result[STORAGE_KEY_PENDING_PUBLISH] || [];
}

/**
 * Remove entries from the pending-publish list whose slugs are now live
 * (i.e. present in the freshly-fetched content-index articles array).
 * Called by manage.js after each successful index fetch.
 * @param {string[]} liveSlugs
 * @returns {Promise<void>}
 */
export async function clearResolvedPendingPublishes(liveSlugs) {
  const result = await chrome.storage.local.get(STORAGE_KEY_PENDING_PUBLISH);
  const existing = result[STORAGE_KEY_PENDING_PUBLISH] || [];
  const liveSet = new Set(liveSlugs);
  const remaining = existing.filter(e => !liveSet.has(e.slug));
  if (remaining.length !== existing.length) {
    await chrome.storage.local.set({ [STORAGE_KEY_PENDING_PUBLISH]: remaining });
  }
}

/**
 * Retrieve the stored shared secret, or null if not set.
 * @returns {Promise<string|null>}
 */
export async function getSharedSecret() {
  const result = await chrome.storage.local.get(STORAGE_KEY_SECRET);
  return result[STORAGE_KEY_SECRET] || null;
}

/**
 * Persist the shared secret.
 * @param {string} secret
 * @returns {Promise<void>}
 */
export async function setSharedSecret(secret) {
  return chrome.storage.local.set({ [STORAGE_KEY_SECRET]: secret });
}

// ── Worker endpoint ───────────────────────────────────────────────────────────

const WORKER_URL = 'https://help-uploader.almir-970.workers.dev/upload';

// ── Valid category slugs (mirrors the spec whitelist) ────────────────────────
// Used for a client-side pre-flight check so authors get instant feedback
// without a round-trip when they've typed an unrecognised category.

const VALID_CATEGORIES = new Set([
  'get-started',
  'advanced-topics',
  'general',
  'account',
  'billing',
  'feedback-360',
  'instant-insights',
  'personal-improvement',
  'privacy-legal',
  'reports',
]);

// ── Result types ─────────────────────────────────────────────────────────────
//
// publishArticle() always resolves (never rejects) and returns one of:
//
//   { status: 'success',  url, previewUrl, slug }
//   { status: 'conflict' }         — user declined the overwrite prompt
//   { status: 'error',   errors }  — array of { field, message } objects
//   { status: 'fatal',   message } — unexpected / network error

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Build the article ZIP and upload it to the help center.
 *
 * @param {object}   recording   — recording record from IndexedDB
 * @param {object[]} groups      — step groups (array of arrays)
 * @param {object}   [options]
 * @param {Function} [options.onProgress]       — (done, total) progress callback
 * @param {Function} [options.onConflict]       — async () => boolean
 *                                                Called when the article already
 *                                                exists.  Return true to overwrite,
 *                                                false to cancel.  Defaults to
 *                                                window.confirm.
 * @returns {Promise<{status, url?, previewUrl?, slug?, errors?, message?}>}
 */
export async function publishArticle(recording, groups, options = {}) {
  const { onProgress, onConflict } = options;

  // ── 1. Pre-flight: shared secret ─────────────────────────────────────────
  const secret = await getSharedSecret();
  if (!secret) {
    return {
      status: 'error',
      errors: [{
        field: 'shared_secret',
        message: 'No shared secret configured. Open Settings and add your Help Center secret.',
      }],
    };
  }

  // ── 2. Pre-flight: category whitelist ────────────────────────────────────
  const meta = recording.meta || {};
  const category = (meta.category || '').trim().toLowerCase();
  if (!category) {
    return {
      status: 'error',
      errors: [{ field: 'category', message: 'Category is required. Set it in the Help-center metadata panel.' }],
    };
  }
  if (!VALID_CATEGORIES.has(category)) {
    // Suggest the closest match if possible (simple prefix check)
    const suggestion = [...VALID_CATEGORIES].find(c => c.startsWith(category.slice(0, 4)));
    const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : '';
    return {
      status: 'error',
      errors: [{ field: 'category', message: `Category "${category}" is not valid.${didYouMean}` }],
    };
  }

  // ── 3. Build the ZIP via the existing Astro export ────────────────────────
  // exportAstro validates required frontmatter fields (title, description,
  // category, slug) and returns validationErrors when something is missing.
  let exportResult;
  try {
    exportResult = await exportAstro(recording, groups, {
      includeVideo: true,
      onProgress,
    });
  } catch (err) {
    return { status: 'fatal', message: `Failed to build article ZIP: ${err.message}` };
  }

  if (exportResult.validationErrors && exportResult.validationErrors.length > 0) {
    return { status: 'error', errors: exportResult.validationErrors };
  }

  const { zipBlob, slug } = exportResult;

  // ── 4. First attempt: action=create ──────────────────────────────────────
  const firstResult = await _postZip({ zipBlob, slug, category, secret, action: 'create' });

  if (firstResult.status === 'success') {
    await recordPublishedSlug(slug, recording.id);
    await recordPendingPublish({
      slug,
      category,
      title:       recording.title || meta.title || '',
      description: meta.description || '',
      recordingId: recording.id,
    });
    return firstResult;
  }

  // ── 5. Handle 409 conflict ───────────────────────────────────────────────
  if (firstResult.status === 'conflict') {
    // Ask the author whether to overwrite
    const confirmOverwrite = onConflict
      ? await onConflict()
      : window.confirm(
          `An article at /${category}/${slug}/ already exists on the help center.\n\nDo you want to overwrite it with this version?`
        );

    if (!confirmOverwrite) {
      return { status: 'conflict' };   // author chose to cancel
    }

    // Retry with action=update
    const updateResult = await _postZip({ zipBlob, slug, category, secret, action: 'update' });
    if (updateResult.status === 'success') {
      await recordPublishedSlug(slug, recording.id);
      await recordPendingPublish({
        slug,
        category,
        title:       recording.title || meta.title || '',
        description: meta.description || '',
        recordingId: recording.id,
      });
    }
    return updateResult;
  }

  // ── 6. Any other error (400, 401, 500, network) ──────────────────────────
  return firstResult;
}

// ── Internal: POST to the Worker ─────────────────────────────────────────────

/**
 * @param {object} params
 * @param {Blob}   params.zipBlob
 * @param {string} params.slug
 * @param {string} params.category
 * @param {string} params.secret
 * @param {'create'|'update'} params.action
 * @returns {Promise<{status, url?, previewUrl?, slug?, errors?, message?}>}
 */
async function _postZip({ zipBlob, slug, category, secret, action }) {
  const body = new FormData();
  body.append('file', zipBlob, `${slug}.zip`);
  body.append('category', category);
  body.append('action', action);

  let response;
  try {
    response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type manually — the browser must set it with the
        // correct multipart boundary for FormData to work.
        Authorization: `Bearer ${secret}`,
      },
      body,
    });
  } catch (networkErr) {
    return {
      status: 'fatal',
      message: `Network error — could not reach the upload endpoint: ${networkErr.message}`,
    };
  }

  // Parse response body (always JSON per spec)
  let data;
  try {
    data = await response.json();
  } catch {
    return {
      status: 'fatal',
      message: `Unexpected response from server (HTTP ${response.status}) — could not parse JSON.`,
    };
  }

  if (response.status === 200 && data.status === 'success') {
    return {
      status: 'success',
      slug: data.slug,
      url: data.url,
      previewUrl: data.previewUrl,
    };
  }

  if (response.status === 409) {
    return { status: 'conflict' };
  }

  if (response.status === 401) {
    return {
      status: 'error',
      errors: [{
        field: 'shared_secret',
        message: 'Invalid or missing shared secret. Check your Help Center secret in Settings.',
      }],
    };
  }

  if (response.status === 400 && Array.isArray(data.errors)) {
    return { status: 'error', errors: data.errors };
  }

  // 500 or any other unexpected status
  return {
    status: 'fatal',
    message: `Server error (HTTP ${response.status}): ${data.message || JSON.stringify(data)}`,
  };
}