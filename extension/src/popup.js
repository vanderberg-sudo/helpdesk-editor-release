// popup.js — Driving the toolbar popup.
//
// Important architectural note: chrome.sidePanel.open() must be called
// from a *user gesture context*. Calling it via a message to the background
// worker is fragile (the gesture token may not survive the round-trip).
// So we call sidePanel.open() directly from this click handler, then
// message the background to do everything else.

import { listRecordings } from './db.js';

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const settingsLink = document.getElementById('settings-link');
const recentLink = document.getElementById('recent-link');
const idleView = document.getElementById('idle-view');
const recordingView = document.getElementById('recording-view');
const recordingsList = document.getElementById('recordings-list');

async function refresh() {
  let status = 'idle';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    status = resp && resp.status ? resp.status : 'idle';
  } catch (e) {
    console.warn('GET_STATUS failed', e);
  }

  if (status === 'recording' || status === 'paused') {
    idleView.style.display = 'none';
    recordingView.style.display = 'block';
  } else {
    idleView.style.display = 'block';
    recordingView.style.display = 'none';
    await renderRecentRecordings();
  }
}

async function renderRecentRecordings() {
  let recs;
  try {
    recs = await listRecordings();
  } catch (e) {
    console.error('listRecordings failed', e);
    recordingsList.innerHTML = '<div style="font-size:12px; color: var(--danger); padding: 8px 0;">Error loading recordings</div>';
    return;
  }

  if (recs.length === 0) {
    recordingsList.innerHTML = '<div style="font-size: 12px; color: var(--text-tertiary); padding: 8px 0;">No recordings yet.</div>';
    return;
  }
  recordingsList.innerHTML = recs.slice(0, 5).map(r => `
    <div class="recording-item" data-id="${r.id}">
      <div>${escapeHtml(r.title || 'Untitled recording')}</div>
      <div class="meta">${r.step_ids.length} steps · ${formatDate(r.created_at)}</div>
    </div>
  `).join('');
  for (const el of recordingsList.querySelectorAll('.recording-item')) {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      chrome.tabs.create({
        url: chrome.runtime.getURL(`editor/editor.html?recording=${id}`),
      });
    });
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function showError(msg) {
  let bar = document.getElementById('error-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'error-bar';
    bar.style.cssText = 'background:#fceaea;color:#a32d2d;padding:10px 12px;font-size:12px;border-radius:6px;margin-bottom:10px;';
    document.querySelector('.body').prepend(bar);
  }
  bar.textContent = msg;
}

startBtn.addEventListener('click', async (clickEvent) => {
  // CRITICAL: chrome.sidePanel.open() must be called synchronously in this
  // click handler, BEFORE any `await`. Even a single awaited call drops the
  // user-gesture token and the open() will fail. We use the current window's
  // id from chrome.windows.WINDOW_ID_CURRENT — no async lookup needed.
  //
  // We can't pre-set the recording-specific URL here (that needs a tab id
  // and an async setOptions call), so we open with the default panel path
  // first and let the background swap the URL afterwards.
  chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    .catch(e => {
      console.error('sidePanel.open failed', e);
      showError('Side panel could not open: ' + e.message);
    });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showError('Could not find the active tab.');
      return;
    }
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://'))) {
      showError('CA-Capture cannot record Chrome internal pages. Open the web app you want to document.');
      return;
    }

    const recording_id = crypto.randomUUID();

    // Tell the background to begin recording. It will also call setOptions
    // to swap the panel URL to the recording-specific one.
    const resp = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tab_id: tab.id,
      recording_id,
    });

    if (resp && resp.error) {
      showError('Could not start: ' + resp.error);
      return;
    }

    window.close();
  } catch (err) {
    console.error('Start failed', err);
    showError('Start failed: ' + err.message);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  } catch (err) {
    console.error('Stop failed', err);
  }
  window.close();
});

settingsLink.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('editor/editor.html?settings=1'),
  });
});

recentLink.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('editor/manage.html'),
  });
});

refresh();