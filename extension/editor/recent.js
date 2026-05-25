// recent.js — Shows all past recordings with name, date, open, and delete.

import { listRecordings, deleteRecording } from '../src/db.js';

const listEl = document.getElementById('list');

async function render() {
  let recs;
  try {
    recs = await listRecordings();
  } catch (e) {
    listEl.innerHTML = `<div class="empty"><p>Could not load recordings.</p></div>`;
    console.error(e);
    return;
  }

  if (!recs || recs.length === 0) {
    listEl.innerHTML = `<div class="empty">
      <p>No recordings yet. Click the CA-Capture toolbar icon and press <strong>Start capture</strong> to begin.</p>
    </div>`;
    return;
  }

  listEl.innerHTML = recs.map(r => `
    <div class="recording-row" data-id="${r.id}">
      <div class="recording-info" data-open="${r.id}">
        <div class="recording-title">${escapeHtml(r.title || 'Untitled recording')}</div>
        <div class="recording-meta">
          <span>${formatDate(r.created_at)}</span>
          <span class="dot">·</span>
          <span>${r.step_ids.length} step${r.step_ids.length === 1 ? '' : 's'}</span>
          <span class="dot">·</span>
          <span>${formatDuration(r.duration_ms)}</span>
        </div>
      </div>
      <div class="recording-actions">
        <button class="btn" data-open="${r.id}">Open</button>
        <button class="btn btn-danger" data-delete="${r.id}">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.addEventListener('click', onListClick);
}

async function onListClick(e) {
  const openId = e.target.closest('[data-open]')?.dataset.open;
  const deleteId = e.target.closest('[data-delete]')?.dataset.delete;

  if (openId) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`editor/editor.html?recording=${openId}`),
    });
    return;
  }
  if (deleteId) {
    const row = e.target.closest('.recording-row');
    const title = row?.querySelector('.recording-title')?.textContent || 'this recording';
    if (!confirm(`Delete "${title}"? This permanently removes the video, screenshots, and steps.`)) return;
    try {
      await deleteRecording(deleteId);
      toast('Recording deleted');
      render();
    } catch (err) {
      console.error(err);
      toast('Delete failed: ' + err.message);
    }
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
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

render();
