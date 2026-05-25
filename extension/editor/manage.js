// manage.js — Help Center article management screen
//
// Two sections:
//   1. Draft Articles  — recordings saved locally, not yet published
//   2. Published Articles — live articles fetched from content-index.json,
//      plus any articles pending their first Cloudflare build.
//
// Filter tabs (All / Drafts / Published) control which section is visible.
// Last selected tab is persisted in chrome.storage.local.
//
// Drafts auto-refresh when the window regains focus so articles published
// in another tab disappear from the draft list automatically.
//
// Pending states
// ──────────────
// After a successful publish, the Cloudflare Pages build takes ~90 seconds.
// During that window content-index.json still reflects the old state, so:
//
//   • A just-published article is shown in the Published section with a
//     "Publish pending · rebuilding…" badge (data from chrome.storage.local).
//     Once the slug appears in a fresh content-index fetch the pending entry
//     is cleared and the live row takes over.
//
//   • A just-deleted article that still appears in content-index.json (stale
//     CDN cache) is shown with a "Deletion pending · rebuilding…" badge and
//     no Delete button.  Once the slug is gone from the index the entry is
//     cleared automatically.

import {
  getSharedSecret,
  getPublishedEntries,
  getPendingPublishes,
  clearResolvedPendingPublishes,
} from './upload.js';
import { listRecordings, deleteRecording } from '../src/db.js';

const CONTENT_INDEX_URL        = 'https://helpdesk-website.pages.dev/content-index.json';
const WORKER_URL               = 'https://help-uploader.almir-970.workers.dev/article';
const TAB_STORAGE_KEY          = 'manage_active_tab';
const STORAGE_KEY_PENDING_DEL  = 'helpdesk_pending_deletes';

const CATEGORY_LABELS = {
  'get-started':         'Get Started',
  'advanced-topics':     'Advanced Topics',
  'general':             'General',
  'account':             'Account',
  'billing':             'Support & Billing',
  'feedback-360':        'Feedback 360',
  'instant-insights':    'Instant Insights',
  'personal-improvement':'Personal Improvement',
  'privacy-legal':       'Privacy & Legal',
  'reports':             'Reports',
};

const SLUG_STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for',
  'of','by','with','from','is','it','as','up','be','its',
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

// ── Pending-delete storage helpers ────────────────────────────────────────────

async function getPendingDeletes() {
  const result = await chrome.storage.local.get(STORAGE_KEY_PENDING_DEL);
  return result[STORAGE_KEY_PENDING_DEL] || [];
}

async function addPendingDelete(slug, category) {
  const existing = await getPendingDeletes();
  const filtered = existing.filter(e => e.slug !== slug);
  filtered.push({ slug, category, deletedAt: Date.now() });
  await chrome.storage.local.set({ [STORAGE_KEY_PENDING_DEL]: filtered });
}

/**
 * Remove entries whose slugs are no longer present in content-index.json
 * (i.e. the build finished and they're truly gone).
 * @param {string[]} liveSlugs — slugs currently in the fetched index
 */
async function clearResolvedPendingDeletes(liveSlugs) {
  const existing = await getPendingDeletes();
  const liveSet = new Set(liveSlugs);
  // An entry is resolved when its slug is absent from the live index.
  const remaining = existing.filter(e => liveSet.has(e.slug));
  if (remaining.length !== existing.length) {
    await chrome.storage.local.set({ [STORAGE_KEY_PENDING_DEL]: remaining });
  }
}

// ── Tab management ────────────────────────────────────────────────────────────

async function initTabs() {
  const stored = await chrome.storage.local.get(TAB_STORAGE_KEY);
  const active = stored[TAB_STORAGE_KEY] || 'all';
  setTab(active);

  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      setTab(tab);
      chrome.storage.local.set({ [TAB_STORAGE_KEY]: tab });
    });
  });
}

function setTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let publishedRecordingIds = new Set(); // IDs of recordings that have been published
let pendingPublishRecordingIds = new Set(); // IDs published but build not yet complete
let sharedSecret = null;

async function main() {
  await initTabs();

  sharedSecret = await getSharedSecret();

  const [indexResult, recordings, pendingPublishes] = await Promise.all([
    fetchIndex(),
    listRecordings().catch(() => []),
    getPendingPublishes(),
  ]);

  const mainEl = document.getElementById('main');
  mainEl.innerHTML = '';

  const liveSlugs = indexResult.ok ? indexResult.articles.map(a => a.slug) : [];
  const liveSlugSet = new Set(liveSlugs);

  // Build published recording ID set:
  //   - IDs stored locally after a successful publish (immediate, no CDN wait)
  const publishedEntries = await getPublishedEntries();
  publishedRecordingIds = new Set(
    publishedEntries.map(e => e.recordingId).filter(Boolean)
  );

  // Clean up pending entries that the index has now confirmed.
  if (indexResult.ok) {
    await clearResolvedPendingDeletes(liveSlugs);
    await clearResolvedPendingPublishes(liveSlugs);
  }

  // Pending deletes: slugs the user deleted this session but content-index
  // still lists (CDN hasn't caught up yet).
  const pendingDeletes = await getPendingDeletes();
  const pendingDeleteSlugs = new Set(pendingDeletes.map(e => e.slug));

  // Pending publishes: articles just published; not yet in content-index.
  // Filter out any that are now confirmed live in the index.
  const pendingPublishRows = pendingPublishes.filter(e => !liveSlugSet.has(e.slug));
  pendingPublishRecordingIds = new Set(
    pendingPublishRows.map(e => e.recordingId).filter(Boolean)
  );

  const drafts = getDrafts(recordings);

  renderDraftsSection(mainEl, drafts);

  if (!indexResult.ok) {
    const banner = errorBanner('Could not load published articles.', indexResult.error);
    banner.classList.add('tab-published');
    mainEl.appendChild(banner);
  } else {
    renderPublishedSection(
      mainEl,
      indexResult.articles,
      pendingDeleteSlugs,
      pendingPublishRows,
      sharedSecret,
    );
  }

  updateTopbarMeta(drafts.length, indexResult.ok ? indexResult.articles.length : 0);

  // WordPress Import link
  const wpImportLink = document.getElementById('wp-import-link');
  if (wpImportLink) {
    wpImportLink.addEventListener('click', () => {
      window.open(chrome.runtime.getURL('editor/wp-import.html'), '_blank');
    });
  }

  // Re-render the drafts section whenever this tab becomes visible again.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const [freshIndex, fresh, freshPendingPublishes] = await Promise.all([
      fetchIndex(),
      listRecordings().catch(() => []),
      getPendingPublishes(),
    ]);

    if (freshIndex.ok) {
      const freshLiveSlugs = freshIndex.articles.map(a => a.slug);
      const freshLiveSlugSet = new Set(freshLiveSlugs);
      await clearResolvedPendingDeletes(freshLiveSlugs);
      await clearResolvedPendingPublishes(freshLiveSlugs);
      const freshPublishedEntries = await getPublishedEntries();
      publishedRecordingIds = new Set(
        freshPublishedEntries.map(e => e.recordingId).filter(Boolean)
      );
      const freshPending = freshPendingPublishes.filter(e => !freshLiveSlugSet.has(e.slug));
      pendingPublishRecordingIds = new Set(
        freshPending.map(e => e.recordingId).filter(Boolean)
      );
    }

    refreshDraftsSection(getDrafts(fresh));
  });
}

function getDrafts(recordings) {
  return recordings.filter(r => {
    if (!r.step_ids || r.step_ids.length === 0) return false;
    // Always include if pending publish — shown with a pending badge in draft list.
    if (pendingPublishRecordingIds.has(r.id)) return true;
    // Exclude if already published (matched by recording ID, not slug).
    return !publishedRecordingIds.has(r.id);
  });
}

// ── Fetch index ───────────────────────────────────────────────────────────────

async function fetchIndex() {
  try {
    const res = await fetch(CONTENT_INDEX_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, articles: data.articles || [] };
  } catch (err) {
    return { ok: false, error: err.message, articles: [] };
  }
}

// ── Drafts section ────────────────────────────────────────────────────────────

function renderDraftsSection(container, drafts) {
  const section = document.createElement('div');
  section.className = 'category-group tab-drafts';
  section.id = 'drafts-section';

  const header = document.createElement('div');
  header.className = 'category-header';
  header.innerHTML = `
    <span class="category-label">Draft Articles</span>
    <span class="category-count" id="drafts-count">${drafts.length}</span>
    <span class="category-sublabel">Saved locally · not yet published</span>
  `;
  section.appendChild(header);

  renderDraftRows(section, drafts);
  container.appendChild(section);
}

function refreshDraftsSection(drafts) {
  const section = document.getElementById('drafts-section');
  if (!section) return;

  const countEl = document.getElementById('drafts-count');
  if (countEl) countEl.textContent = drafts.length;

  section.querySelectorAll('.article-row, .empty-category').forEach(el => el.remove());

  renderDraftRows(section, drafts);

  const metaEl = document.getElementById('topbar-meta');
  if (metaEl) {
    metaEl.textContent = metaEl.textContent.replace(/\d+ draft/, `${drafts.length} draft`);
  }
}

function renderDraftRows(section, drafts) {
  if (drafts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-category';
    empty.textContent = 'No unpublished drafts.';
    section.appendChild(empty);
  } else {
    for (const rec of drafts) {
      section.appendChild(buildDraftRow(rec, section));
    }
  }
}

function buildDraftRow(rec, sectionEl) {
  const row = document.createElement('div');
  row.id = `draft-row-${rec.id}`;

  const created = rec.created_at
    ? new Date(rec.created_at).toLocaleDateString() : '';
  const stepCount = rec.step_ids ? rec.step_ids.length : 0;
  const slug = slugify(rec.title || '');
  const isPendingPublish = pendingPublishRecordingIds.has(rec.id);

  row.className = isPendingPublish ? 'article-row pending-state' : 'article-row';

  row.innerHTML = `
    <div class="article-info">
      <div class="article-title">${escapeHtml(rec.title || '(Untitled)')}</div>
      <div class="article-description draft-hint">${isPendingPublish ? 'Published · waiting for site rebuild' : 'Not published yet'}</div>
      <div class="article-meta">
        ${created ? `<span>Created ${escapeHtml(created)}</span>` : ''}
        <span>${stepCount} step${stepCount !== 1 ? 's' : ''}</span>
        <span class="slug-preview">${escapeHtml(slug)}</span>
      </div>
      <div class="row-error" id="draft-err-${rec.id}"></div>
    </div>
    <div class="article-actions draft-actions">
      ${isPendingPublish
        ? `<span class="pending-badge pending-badge--publish">⏳ Publish pending · rebuilding…</span>`
        : `<button class="btn-action btn-edit">Edit</button>
           <button class="btn-action btn-delete-draft">Delete</button>`
      }
    </div>
  `;

  if (!isPendingPublish) {
    const editorUrl = chrome.runtime.getURL(`editor/editor.html?recording=${rec.id}`);
    row.querySelector('.btn-edit').addEventListener('click', () =>
      window.open(editorUrl, '_blank')
    );
    row.querySelector('.btn-delete-draft').addEventListener('click', () =>
      handleDraftDelete(rec, row, sectionEl)
    );
  }

  return row;
}

async function handleDraftDelete(rec, row, sectionEl) {
  const confirmed = window.confirm(
    `Delete "${rec.title || 'Untitled'}"?\n\n` +
    `This will permanently remove the recording and all its screenshots ` +
    `from your local storage. This action cannot be undone.`
  );
  if (!confirmed) return;

  const btn = row.querySelector('.btn-delete-draft');
  const errEl = row.querySelector(`#draft-err-${rec.id}`);
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  row.classList.add('deleting');

  try {
    await deleteRecording(rec.id);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Delete';
    row.classList.remove('deleting');
    errEl.textContent = `Delete failed: ${err.message}`;
    errEl.classList.add('visible');
    return;
  }

  row.classList.remove('deleting');
  row.classList.add('deleted');
  setTimeout(() => {
    row.remove();
    updateCount('drafts-count', -1, sectionEl, 'No unpublished drafts.');
    updateTopbar('draft', -1);
  }, 750);
}

// ── Published section ─────────────────────────────────────────────────────────

/**
 * @param {HTMLElement}  container
 * @param {object[]}     articles          — from content-index.json
 * @param {Set<string>}  pendingDeleteSlugs — slugs deleted but CDN not yet rebuilt
 * @param {object[]}     pendingPublishRows — articles published but not yet in index
 * @param {string|null}  secret
 */
function renderPublishedSection(container, articles, pendingDeleteSlugs, pendingPublishRows, secret) {
  const divider = document.createElement('div');
  divider.className = 'section-divider tab-published';
  divider.innerHTML = `<span class="section-divider-label">Published Articles</span>`;
  container.appendChild(divider);

  // Group live articles by category.
  const grouped = new Map();
  for (const slug of Object.keys(CATEGORY_LABELS)) grouped.set(slug, []);
  for (const article of articles) {
    if (!grouped.has(article.category)) grouped.set(article.category, []);
    grouped.get(article.category).push(article);
  }

  // Inject pending-publish entries into their respective categories so they
  // appear in the right group even before content-index reflects them.
  for (const pending of pendingPublishRows) {
    if (!grouped.has(pending.category)) grouped.set(pending.category, []);
    // Only inject if not already present in live data (defensive).
    const already = grouped.get(pending.category).some(a => a.slug === pending.slug);
    if (!already) grouped.get(pending.category).unshift(pending);
  }

  for (const [category, categoryArticles] of grouped.entries()) {
    if (categoryArticles.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'category-group tab-published';
    group.id = `category-${category}`;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="category-label">${CATEGORY_LABELS[category] || category}</span>
      <span class="category-count" id="count-${category}">${categoryArticles.length}</span>
    `;
    group.appendChild(header);

    for (const article of categoryArticles) {
      const isPendingDelete  = pendingDeleteSlugs.has(article.slug);
      const isPendingPublish = pendingPublishRows.some(e => e.slug === article.slug);

      if (isPendingDelete) {
        group.appendChild(buildPendingDeleteRow(article, category));
      } else if (isPendingPublish) {
        group.appendChild(buildPendingPublishRow(article, category));
      } else {
        group.appendChild(buildPublishedRow(article, category, secret, group));
      }
    }

    container.appendChild(group);
  }
}

// ── Pending-delete row ────────────────────────────────────────────────────────

function buildPendingDeleteRow(article, category) {
  const row = document.createElement('div');
  row.className = 'article-row pending-state';
  row.id = `row-${category}-${article.slug}`;

  const liveUrl = `https://helpdesk-website.pages.dev${article.url}`;

  row.innerHTML = `
    <div class="article-info">
      <div class="article-title">${escapeHtml(article.title)}</div>
      <div class="article-description">${escapeHtml(article.description || '—')}</div>
      <div class="article-meta">
        <a href="${liveUrl}" target="_blank" rel="noopener">View live ↗</a>
        <span>${escapeHtml(article.slug)}</span>
      </div>
    </div>
    <div class="article-actions">
      <span class="pending-badge pending-badge--delete">🗑 Deletion pending · rebuilding…</span>
    </div>
  `;

  return row;
}

// ── Pending-publish row ───────────────────────────────────────────────────────

function buildPendingPublishRow(entry, category) {
  const row = document.createElement('div');
  row.className = 'article-row pending-state';
  row.id = `row-pending-${category}-${entry.slug}`;

  // We don't have the live URL yet (slug may not exist on the site).
  // Show the expected URL so the author knows where it will land.
  const expectedUrl = `https://helpdesk-website.pages.dev/${category}/${entry.slug}/`;

  row.innerHTML = `
    <div class="article-info">
      <div class="article-title">${escapeHtml(entry.title || entry.slug)}</div>
      <div class="article-description">${escapeHtml(entry.description || '—')}</div>
      <div class="article-meta">
        <a href="${expectedUrl}" target="_blank" rel="noopener">View live ↗</a>
        <span>${escapeHtml(entry.slug)}</span>
      </div>
    </div>
    <div class="article-actions">
      <span class="pending-badge pending-badge--publish">⏳ Publish pending · rebuilding…</span>
    </div>
  `;

  return row;
}

// ── Live published row ────────────────────────────────────────────────────────

function buildPublishedRow(article, category, secret, groupEl) {
  const row = document.createElement('div');
  row.className = 'article-row';
  row.id = `row-${category}-${article.slug}`;

  const liveUrl     = `https://helpdesk-website.pages.dev${article.url}`;
  const lastUpdated = article.lastUpdated ? `Updated ${article.lastUpdated}` : '';

  row.innerHTML = `
    <div class="article-info">
      <div class="article-title">${escapeHtml(article.title)}</div>
      <div class="article-description">${escapeHtml(article.description || '—')}</div>
      <div class="article-meta">
        <a href="${liveUrl}" target="_blank" rel="noopener">View live ↗</a>
        ${lastUpdated ? `<span>${escapeHtml(lastUpdated)}</span>` : ''}
        <span>${escapeHtml(article.slug)}</span>
      </div>
      <div class="row-error" id="err-${category}-${article.slug}"></div>
    </div>
    <div class="article-actions">
      <button class="btn-delete">
        <span class="btn-spinner"></span>
        <span class="btn-label">Delete</span>
      </button>
    </div>
  `;

  row.querySelector('.btn-delete').addEventListener('click', () =>
    handlePublishedDelete(article, category, secret, row, groupEl)
  );

  return row;
}

async function handlePublishedDelete(article, category, secret, row, groupEl) {
  const confirmed = window.confirm(
    `Delete "${article.title}"?\n\n` +
    `This will permanently remove the article from the help center. ` +
    `The site will rebuild in ~90 seconds.\n\nThis action cannot be undone.`
  );
  if (!confirmed) return;

  if (!secret) {
    const errEl = row.querySelector('.row-error');
    errEl.textContent = 'No shared secret configured. Open Settings in the editor.';
    errEl.classList.add('visible');
    return;
  }

  const btn   = row.querySelector('.btn-delete');
  const label = row.querySelector('.btn-label');
  const errEl = row.querySelector('.row-error');
  btn.disabled = true;
  btn.classList.add('pending');
  label.textContent = 'Deleting…';
  row.classList.add('deleting');
  errEl.classList.remove('visible');

  try {
    const res = await fetch(WORKER_URL, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ category, slug: article.slug }),
    });
    const result = await res.json();
    if (!res.ok || result.status !== 'success') {
      throw new Error(result.errors?.[0]?.message || `Server error (HTTP ${res.status})`);
    }
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('pending');
    label.textContent = 'Delete';
    row.classList.remove('deleting');
    errEl.textContent = `Delete failed: ${err.message}`;
    errEl.classList.add('visible');
    return;
  }

  // Record the pending delete before swapping the row, so a refresh
  // immediately shows the pending state rather than re-enabling Delete.
  await addPendingDelete(article.slug, category);

  // Swap the live row for a pending-delete row in place.
  const pendingRow = buildPendingDeleteRow(article, category);
  row.replaceWith(pendingRow);

  updateTopbar('published', 0); // count stays the same — row is still visible
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function updateTopbarMeta(draftCount, publishedCount) {
  const metaEl = document.getElementById('topbar-meta');
  if (!metaEl) return;
  metaEl.textContent =
    `${draftCount} draft${draftCount !== 1 ? 's' : ''} · ` +
    `${publishedCount} published · ` +
    `last fetched ${new Date().toLocaleTimeString()}`;
}

function updateCount(countId, delta, sectionEl, emptyMessage) {
  const countEl = document.getElementById(countId);
  if (!countEl) return;
  const next = Math.max(0, parseInt(countEl.textContent, 10) + delta);
  countEl.textContent = next;
  if (next === 0) {
    if (emptyMessage) {
      const empty = document.createElement('p');
      empty.className = 'empty-category';
      empty.textContent = emptyMessage;
      sectionEl.appendChild(empty);
    } else if (sectionEl) {
      sectionEl.remove();
    }
  }
}

function updateTopbar(type, delta) {
  const metaEl = document.getElementById('topbar-meta');
  if (!metaEl) return;
  if (type === 'draft') {
    metaEl.textContent = metaEl.textContent.replace(/(\d+) draft/, (_, n) =>
      `${Math.max(0, parseInt(n) + delta)} draft`
    );
  } else {
    metaEl.textContent = metaEl.textContent.replace(/(\d+) published/, (_, n) =>
      `${Math.max(0, parseInt(n) + delta)} published`
    );
  }
}

function errorBanner(title, detail) {
  const div = document.createElement('div');
  div.className = 'error-banner';
  div.innerHTML = `<div><strong>${escapeHtml(title)}</strong><br>
    <span style="font-size:12px;">${escapeHtml(detail || '')}</span></div>`;
  return div;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

main();