// offscreen.js — Hosts the MediaRecorder for tab video.
// The service worker delegates here because MediaRecorder is unavailable
// in service worker contexts in MV3.

let recorder = null;
let chunks = [];
let stream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'OFFSCREEN_START_RECORDING':
          await startRecording(msg.streamId);
          sendResponse({ ok: true });
          break;
        case 'OFFSCREEN_STOP_RECORDING':
          await stopRecording();
          sendResponse({ ok: true });
          break;
      }
    } catch (e) {
      console.error('Offscreen error', e);
      sendResponse({ error: e.message });
    }
  })();
  return true;
});

async function startRecording(streamId) {
  // Get the actual MediaStream using the ID handed to us by the service worker
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    // Send back to service worker as data URL (Blob can't cross context boundaries)
    const reader = new FileReader();
    reader.onloadend = () => {
      chrome.runtime.sendMessage({
        type: 'VIDEO_BLOB_READY',
        blob_data: reader.result,
      });
    };
    reader.readAsDataURL(blob);

    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  };
  recorder.start(1000); // emit a chunk every second
}

async function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}
