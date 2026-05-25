// background.js — Service worker. Orchestrates recording.
//
// State machine:
//   idle  →  recording  →  idle
//          (start)       (stop, opens editor)
//
// Receives messages from:
//   - popup (start, stop, get status)
//   - content script (click captured)
//   - recording panel (stop, pause)
//
// Sends messages to:
//   - content script (start listening, stop listening)
//   - recording panel (step added, status changed)

import {
  openDB, putRecording, putStep, putBlob, uuid
} from './db.js';
import { decideGrouping } from './grouping.js';

const state = {
  status: 'idle',       // 'idle' | 'recording' | 'paused'
  recording_id: null,
  tab_id: null,
  window_id: null,      // the browser window hosting the side panel
  started_at: null,
  steps: [],            // in-memory step list during recording
  last_click: null,
  current_group_id: null,
  current_group_order: 0,
  video_recorder_active: false,
  // Recording ID that the offscreen video recorder is currently associated
  // with — needed because the video blob arrives AFTER stopRecording clears
  // state.recording_id.
  pending_video_recording_id: null,
};

// ---- Lifecycle ----

chrome.runtime.onInstalled.addListener(async () => {
  await openDB();
  // Make sure clicking the toolbar icon opens our popup, not the side panel.
  // The side panel is reserved for the recording panel, opened programmatically.
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    // Older Chrome versions don't have setPanelBehavior; safe to ignore.
  }
  console.log('StepCast installed');
});

// If the captured tab is closed during recording, stop gracefully.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.tab_id === tabId && state.status !== 'idle') {
    // The tab is gone; mark it null so stopRecording doesn't try to message it
    state.tab_id = null;
    await stopRecording();
  }
});

// ---- Message handling ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // We return true from this listener whenever we use sendResponse
  // asynchronously, so Chrome keeps the message channel open.
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATUS':
          sendResponse({ status: state.status, recording_id: state.recording_id });
          break;

        case 'START_RECORDING':
          await startRecording(msg.tab_id, msg.recording_id);
          sendResponse({ ok: true, recording_id: state.recording_id });
          break;

        case 'STOP_RECORDING':
          // Respond immediately — the actual stop work runs in the background
          // so the popup/panel never hangs waiting on us. Errors during stop
          // are logged but never block the caller.
          sendResponse({ ok: true });
          stopRecording().catch(err => console.error('[StepCast] stopRecording failed', err));
          break;

        case 'PAUSE_RECORDING':
          state.status = 'paused';
          notifyPanel({ type: 'STATUS_CHANGED', status: 'paused' });
          sendResponse({ ok: true });
          break;

        case 'RESUME_RECORDING':
          state.status = 'recording';
          notifyPanel({ type: 'STATUS_CHANGED', status: 'recording' });
          sendResponse({ ok: true });
          break;

        case 'CLICK_CAPTURED':
          await handleClickCaptured(msg.click, sender.tab.id);
          sendResponse({ ok: true });
          break;

        case 'VIDEO_BLOB_READY':
          // Pass the whole message; handleVideoBlob destructures { blob_data }.
          await handleVideoBlob(msg);
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ error: 'Unknown message type: ' + msg.type });
      }
    } catch (err) {
      console.error('Error handling message', msg, err);
      sendResponse({ error: err.message });
    }
  })();
  return true;
});

// ---- Recording lifecycle ----

async function startRecording(tab_id, recording_id) {
  if (state.status !== 'idle') {
    throw new Error('Already recording');
  }

  console.log('[StepCast] startRecording', { tab_id, recording_id });

  const tab = await chrome.tabs.get(tab_id);

  // Use the id the popup generated (so the side panel URL it set up matches)
  // or generate a fresh one if called without an id (legacy / programmatic).
  state.recording_id = recording_id || uuid();
  state.tab_id = tab_id;
  state.window_id = tab.windowId;
  state.started_at = Date.now();
  state.steps = [];
  state.last_click = null;
  state.current_group_id = null;
  state.current_group_order = 0;
  state.status = 'recording';

  // Inject content script into the captured tab to listen for clicks.
  // The recording PANEL is the Chrome side panel — see below — which docks
  // beside the tab, OUTSIDE the captured tab's viewport. captureVisibleTab
  // photographs the tab only, so the panel never appears in screenshots.
  await chrome.scripting.executeScript({
    target: { tabId: tab_id },
    files: ['src/content.js'],
  });

  // Start video capture in an offscreen document
  // (Service workers can't use MediaRecorder; offscreen documents can.)
  await startVideoCapture(tab_id);

  // Set the side panel URL to the recording-specific page. The popup already
  // called sidePanel.open() before sending us this message, so the panel
  // is opening (or already open) with the default path. Setting options
  // here either updates an open panel or pre-configures a closed one.
  await chrome.sidePanel.setOptions({
    tabId: tab_id,
    path: `src/recording-panel.html?recording=${state.recording_id}`,
    enabled: true,
  });

  // Tell content script to start listening
  await chrome.tabs.sendMessage(tab_id, {
    type: 'START_LISTENING',
    recording_id: state.recording_id,
  });
}

async function stopRecording() {
  if (state.status === 'idle') return;

  console.log('[StepCast] stopRecording');
  state.status = 'idle';
  stopVideoCapture();

  // Tell the content script to stop listening — race against a 1s timeout
  // so a hung tab can't block us.
  if (state.tab_id) {
    await raceWithTimeout(
      chrome.tabs.sendMessage(state.tab_id, { type: 'STOP_LISTENING' }).catch(() => {}),
      1000
    );
  }

  // Disable the side panel for this tab (this closes it). Also raced.
  if (state.tab_id) {
    await raceWithTimeout(
      chrome.sidePanel.setOptions({ tabId: state.tab_id, enabled: false }).catch(() => {}),
      1000
    );
  }

  // Persist the recording record (video_blob_id added later when video arrives)
  let tab = null;
  if (state.tab_id) {
    tab = await raceWithTimeout(chrome.tabs.get(state.tab_id).catch(() => null), 1000);
  }
  const recording = {
    id: state.recording_id,
    title: '',
    created_at: new Date(state.started_at).toISOString(),
    duration_ms: Date.now() - state.started_at,
    url_origin: tab && tab.url ? new URL(tab.url).origin : '',
    step_ids: state.steps.map(s => s.id),
    video_blob_id: null,
    source: 'capture',
  };
  await putRecording(recording);

  // Persist any in-memory steps (we write as-we-go, this is a safety net).
  for (const step of state.steps) {
    try { await putStep(step); } catch (e) { console.warn('putStep failed', e); }
  }

  // Open the editor in a new tab. Pass recording_id via query string.
  const editor_url = chrome.runtime.getURL(
    `editor/editor.html?recording=${state.recording_id}`
  );
  await chrome.tabs.create({ url: editor_url });

  // Reset
  state.recording_id = null;
  state.tab_id = null;
  state.window_id = null;
}

// Race a promise against a timeout. If the timeout wins, resolves with null
// instead of hanging. We use this for Chrome API calls that can occasionally
// stall (e.g. messaging a tab that hasn't finished loading).
function raceWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ]);
}

// ---- Click capture ----

async function handleClickCaptured(click, tab_id) {
  if (state.status !== 'recording') return;

  // Take screenshot of the visible tab
  let screenshot_data_url;
  try {
    screenshot_data_url = await chrome.tabs.captureVisibleTab(
      undefined, // current window
      { format: 'png' }
    );
  } catch (err) {
    console.error('Screenshot capture failed', err);
    return;
  }

  // Convert data URL to Blob
  const screenshot_blob = await dataUrlToBlob(screenshot_data_url);
  const screenshot_blob_id = uuid();
  await putBlob(screenshot_blob_id, 'screenshot', screenshot_blob);

  // Decide grouping
  const decision = decideGrouping(state.last_click, click);
  if (decision === 'new' || !state.current_group_id) {
    state.current_group_id = uuid();
    state.current_group_order = 0;
  } else {
    state.current_group_order += 1;
  }

  const step = {
    id: uuid(),
    recording_id: state.recording_id,
    group_id: state.current_group_id,
    order_in_group: state.current_group_order,
    click: {
      url: click.url,
      selector: click.selector,
      element_label: click.element_label,
      label_visible: click.label_visible !== false,
      bounding_box: click.bounding_box,
      device_pixel_ratio: click.device_pixel_ratio || 1,
    },
    screenshot_blob_id,
    video_timestamp_ms: Date.now() - state.started_at,
    ai_title: '',
    ai_description: '',
    user_title: null,
    user_description: null,
    created_at: new Date().toISOString(),
  };

  state.steps.push(step);
  state.last_click = click;
  await putStep(step);

  // Notify the recording panel
  notifyPanel({
    type: 'STEP_ADDED',
    step,
    decision,
    total_steps: state.steps.length,
  });
}

// ---- Video capture (offscreen document) ----

async function startVideoCapture(tab_id) {
  // chrome.tabCapture needs to be initiated from a user gesture context.
  // We get one via the popup click. Get the stream ID and pass it to an
  // offscreen document that owns the MediaRecorder.

  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen.html'),
      reasons: ['USER_MEDIA'],
      justification: 'Record tab video via MediaRecorder for how-to capture.',
    });
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab_id,
  });

  // Tell the offscreen doc to start recording with this stream
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START_RECORDING',
    streamId,
  });

  state.video_recorder_active = true;
  state.pending_video_recording_id = state.recording_id;
}

function stopVideoCapture() {
  if (!state.video_recorder_active) return;
  state.video_recorder_active = false;
  // Fire-and-forget. The offscreen doc handles teardown asynchronously and
  // sends VIDEO_BLOB_READY back to us when the WebM is ready. We must NOT
  // await this — if the offscreen doc is unresponsive or the MediaRecorder
  // takes a while to finalize, awaiting blocks stopRecording indefinitely.
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_RECORDING' }).catch(() => {});
}

async function handleVideoBlob({ blob_data }) {
  // blob_data is a base64 string from offscreen doc; convert to Blob
  const blob = await dataUrlToBlob(blob_data);
  const video_blob_id = uuid();
  await putBlob(video_blob_id, 'video', blob);

  // Link this video to the recording it was captured for. We tracked the
  // ID at video-start time because state.recording_id is cleared by
  // stopRecording before this callback fires.
  const recording_id = state.pending_video_recording_id;
  state.pending_video_recording_id = null;

  if (recording_id) {
    const db = await openDB();
    const t = db.transaction('recordings', 'readwrite');
    const store = t.objectStore('recordings');
    const target = await new Promise((resolve, reject) => {
      const req = store.get(recording_id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (target) {
      target.video_blob_id = video_blob_id;
      store.put(target);
    }
  }

  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

// Convert a data: URL to a Blob WITHOUT using fetch().
// Service workers in some Chrome versions reject `fetch('data:...')` with
// TypeError: Failed to fetch — we decode the base64 ourselves to avoid that.
function dataUrlToBlob(dataUrl) {
  // dataUrl format: "data:<mime>;base64,<data>"
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) throw new Error('Invalid data URL');
  const meta = dataUrl.slice(5, commaIdx); // strip "data:"
  const data = dataUrl.slice(commaIdx + 1);
  const isBase64 = meta.includes(';base64');
  const mime = meta.split(';')[0] || 'application/octet-stream';

  let bytes;
  if (isBase64) {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(data));
  }
  return new Blob([bytes], { type: mime });
}

function notifyPanel(msg) {
  // The recording panel is an extension page (popup window). It listens
  // for runtime messages directly, so we just broadcast. Catch and ignore
  // "no receiver" errors that happen if the panel window is closed.
  chrome.runtime.sendMessage(msg).catch(() => {});
}
