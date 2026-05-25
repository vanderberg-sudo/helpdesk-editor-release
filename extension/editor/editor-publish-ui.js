// editor-publish-ui.js — Publish-related UI overlays.
//
// Owns:
//   showPublishSuccessBanner(url)  — green top banner with live article link
//   showPublishErrors(errors)      — modal listing validation / Worker errors
//   showProgressOverlay(title, n)  — spinner modal used during exports
//   showFallbackClipboardModal(html) — manual-copy fallback for clipboard failures

// ── Success banner ────────────────────────────────────────────────────────────

/**
 * Show a dismissible green banner at the top of the editor.
 * Requires the author to click ✕ — never auto-dismisses (they need the URL).
 * @param {string} url — live article URL
 */
export function showPublishSuccessBanner(url) {
  const existing = document.getElementById('publish-success-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'publish-success-banner';
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
    'background:#166534', 'color:#fff',
    'padding:12px 20px',
    'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:16px',
    'font-size:14px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
  ].join(';');

  const msg  = document.createElement('span');
  msg.textContent = '✓ Article queued — live in approximately 90 seconds. ';

  const link = document.createElement('a');
  link.href      = url;
  link.target    = '_blank';
  link.rel       = 'noopener';
  link.textContent = 'View article →';
  link.style.cssText = 'color:#86efac;font-weight:500;text-decoration:underline;';
  msg.appendChild(link);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Dismiss';
  closeBtn.style.cssText = [
    'background:none', 'border:none', 'color:#fff',
    'font-size:16px', 'cursor:pointer', 'padding:0 4px', 'line-height:1', 'opacity:0.8',
  ].join(';');
  closeBtn.addEventListener('click', () => banner.remove());

  banner.appendChild(msg);
  banner.appendChild(closeBtn);
  document.body.prepend(banner);
}

// ── Error modal ───────────────────────────────────────────────────────────────

/**
 * Show validation / Worker errors in a modal.
 * Requires explicit ✕ close — never dismisses on backdrop click.
 * @param {Array<{field: string, message: string}>} errors
 */
export function showPublishErrors(errors) {
  const existing = document.getElementById('publish-error-backdrop');
  if (existing) existing.remove();

  const isSecretError = errors.some(e => e.field === 'shared_secret');

  const errorItems = errors.map(e =>
    `<li style="margin-bottom:8px;">
       <strong style="color:var(--danger);">${escapeHtml(e.field)}:</strong>
       ${escapeHtml(e.message)}
     </li>`
  ).join('');

  const settingsHint = isSecretError
    ? `<p style="margin:16px 0 0;font-size:13px;color:var(--text-secondary);">
         Open <strong>Settings</strong> (bottom-right link) to add your Help Center shared secret.
       </p>`
    : '';

  const backdrop = document.createElement('div');
  backdrop.id        = 'publish-error-backdrop';
  backdrop.className = 'modal-backdrop';
  backdrop.style.display = 'flex';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Publish failed</h2>
        <button class="icon-btn" id="close-publish-error-btn">✕</button>
      </div>
      <div class="modal-body">
        <ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.6;">
          ${errorItems}
        </ul>
        ${settingsHint}
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.querySelector('#close-publish-error-btn')
    .addEventListener('click', () => backdrop.remove());
}

// ── Progress overlay ──────────────────────────────────────────────────────────

/**
 * Show a spinner overlay with a step counter.
 * Returns { update(done, total), close() }.
 * @param {string} title
 * @param {number} total
 */
export function showProgressOverlay(title, total) {
  const backdrop = document.createElement('div');
  backdrop.className    = 'modal-backdrop';
  backdrop.style.display = 'flex';
  backdrop.innerHTML = `
    <div class="modal" style="width:360px;">
      <div class="modal-body" style="text-align:center;padding:28px;">
        <div style="margin-bottom:14px;font-weight:500;">${escapeHtml(title)}</div>
        <div style="margin-bottom:14px;">
          <span class="spinner" style="width:18px;height:18px;border-width:3px;color:var(--info)"></span>
        </div>
        <div id="progress-text" style="font-size:13px;color:var(--text-secondary);">
          Step 0 of ${total}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textEl = backdrop.querySelector('#progress-text');
  return {
    update(done, t) { textEl.textContent = `Step ${done} of ${t}`; },
    close()         { backdrop.remove(); },
  };
}

// ── Fallback clipboard modal ──────────────────────────────────────────────────

/**
 * Show a read-only textarea the user can manually select and copy from.
 * Used when navigator.clipboard.writeText() fails.
 * @param {string} html
 */
export function showFallbackClipboardModal(html) {
  const backdrop = document.createElement('div');
  backdrop.className    = 'modal-backdrop';
  backdrop.style.display = 'flex';
  backdrop.innerHTML = `
    <div class="modal" style="width:600px;max-width:92vw;">
      <div class="modal-header">
        <h2>Copy HTML manually</h2>
        <button class="icon-btn" id="fallback-close">✕</button>
      </div>
      <div class="modal-body">
        <p class="field-help">Auto-copy failed. Click below, select all, and copy.</p>
        <textarea readonly style="width:100%;min-height:200px;font-family:ui-monospace,monospace;font-size:11px;"></textarea>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector('textarea');
  textarea.value = html;
  textarea.addEventListener('focus', () => textarea.select());
  backdrop.querySelector('#fallback-close').addEventListener('click', () => backdrop.remove());
}

// ── Private ───────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}