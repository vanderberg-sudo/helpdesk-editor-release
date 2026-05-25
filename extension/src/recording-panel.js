// recording-panel.js — Runs inside the separate Chrome popup window that
// hosts the recording panel. Listens for runtime messages from the
// background worker (STEP_ADDED, STATUS_CHANGED) and sends commands back
// (STOP_RECORDING, PAUSE_RECORDING, RESUME_RECORDING).

const params = new URLSearchParams(location.search);
const recording_id = params.get('recording');

const stepsListEl = document.getElementById('steps-list');
const stepCountEl = document.getElementById('step-count');
const suggestedTitleEl = document.getElementById('suggested-title');
const stopBtn = document.getElementById('stop-btn');
const pauseBtn = document.getElementById('pause-btn');
const closeBtn = document.getElementById('close-btn');
const timerEl = document.getElementById('timer');

let started_at = Date.now();
let steps = [];
let paused = false;

// Update timer
setInterval(() => {
  if (paused) return;
  const elapsed_ms = Date.now() - started_at;
  const s = Math.floor(elapsed_ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  timerEl.textContent = `${mm}:${ss}`;
}, 1000);

// Listen for messages from the background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'STEP_ADDED':
      onStepAdded(msg.step, msg.decision);
      break;
    case 'STATUS_CHANGED':
      paused = msg.status === 'paused';
      pauseBtn.textContent = paused ? '▶' : '⏸';
      break;
  }
});

function onStepAdded(step, decision) {
  steps.push(step);
  stepCountEl.textContent = steps.length;
  // Clear empty state
  const empty = stepsListEl.querySelector('.empty-state');
  if (empty) empty.remove();

  // Remove "new" class from prior items
  for (const el of stepsListEl.querySelectorAll('.step-item.new')) {
    el.classList.remove('new');
  }

  const el = document.createElement('div');
  el.className = 'step-item new';
  const groupingNote = decision === 'group'
    ? ' · grouped with prev'
    : ' · new step';
  el.innerHTML = `
    <div class="step-num">${steps.length}</div>
    <div class="step-content">
      <div class="step-label">Click <strong>${escapeHtml(step.click.element_label.slice(0, 40))}</strong></div>
      <div class="step-meta">${escapeHtml(pathOf(step.click.url))} · ${formatTime(step.video_timestamp_ms)}${groupingNote}</div>
    </div>
  `;
  stepsListEl.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update suggested title heuristically (real AI title comes in the editor)
  if (steps.length === 1) {
    suggestedTitleEl.textContent = `How to use ${pathOf(step.click.url) || 'this page'}`;
  } else if (steps.length >= 3) {
    const last = steps[steps.length - 1].click.element_label;
    suggestedTitleEl.textContent = `How to ${last.toLowerCase()} (and more)`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

stopBtn.addEventListener('click', () => {
  // Disable the button immediately so we can't double-fire
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  // Send the stop message, then close OUR OWN window. There is no
  // chrome.sidePanel.close() API — the side panel can only be closed by
  // calling window.close() from inside it. setOptions({enabled:false}) in
  // the background does not close an already-open panel.
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});
  // Give the background a beat to start processing before we unload.
  setTimeout(() => { try { window.close(); } catch {} }, 200);
});

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  chrome.runtime.sendMessage({
    type: paused ? 'PAUSE_RECORDING' : 'RESUME_RECORDING',
  });
  pauseBtn.textContent = paused ? '▶' : '⏸';
});

closeBtn.addEventListener('click', () => {
  if (confirm('Stop recording and close?')) {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});
    setTimeout(() => { try { window.close(); } catch {} }, 200);
  }
});
