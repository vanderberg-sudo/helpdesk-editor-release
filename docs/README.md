# CA-Capture

A Chrome extension that turns a recorded click-through of any web
application into a publishable how-to article with AI-generated
descriptions. Built for the Comparative Agility help center.

**Current version:** 1.1.2

---

## What it does

- Records a screen video of any web app workflow
- Captures a screenshot at every click, with the click target annotated
  (highlight + label callout on icon-only buttons)
- Uses Claude (Anthropic API) to generate step titles and descriptions
- Lets you edit, reorder, and refine in a built-in editor
- Exports as standalone HTML, asset bundle (zip), embed snippet, or
  **one-click Copy for WordPress** with annotated screenshots baked in

All data is stored locally in your browser — no servers, no telemetry.

---

## Installing (developer mode)

Until this is published to the Workspace Chrome Web Store, install the
unpacked version:

1. Download the latest `ca-capture.zip` from the [Releases page](../../releases)
2. Unzip the file
3. Open `chrome://extensions/` and enable **Developer Mode** (toggle, top right)
4. Click **Load unpacked** and select the `extension/` folder inside the
   unzipped folder
5. Pin the extension so it's always visible (puzzle-piece icon → pin)
6. Click the CA-Capture icon → **Settings** → paste your Anthropic API
   key → **Save**

To use:

1. Open any web app
2. Click the CA-Capture icon → **Start capture**
3. Click through the workflow
4. Click **Stop** in the side panel
5. Edit in the editor that opens, then **Share & export**

**Notes:**

- Chrome will show a "Disable developer extensions" warning each launch
  — you can dismiss it.
- The extension does not auto-update. When a new version ships:
  download the new zip, unzip, then click the reload icon (↻) on the
  CA-Capture card in `chrome://extensions/`.
- Don't move the unzipped folder after loading it — Chrome reads files
  from that exact path.

---

## Repository contents

```
ca-capture/
├── README.md                       this file
├── extension/                      the Chrome extension (load this)
│   ├── manifest.json
│   ├── icons/                      16/32/128 px PNG icons
│   ├── src/                        background, content script, popup, panel
│   └── editor/                     post-recording editor and export logic
└── docs/
    ├── SPEC.md                     full technical specification
    ├── DISTRIBUTION-CHECKLIST.md   step-by-step for publishing privately
    │                               via Google Workspace
    └── CHANGELOG.md                version history
```

---

## Architecture in one paragraph

The background service worker orchestrates everything. When you start
recording, it spawns an offscreen document to run `MediaRecorder` on the
tab capture stream, opens Chrome's side panel for the recording controls
(side panel docks beside the tab, so it doesn't appear in screenshots),
and injects a content script into the captured tab. The content script
listens for `mousedown` events, picks the best interactive ancestor of
the click target, tightens the bounding box to the visible content, and
posts the click metadata to the worker. The worker screenshots the tab
via `chrome.tabs.captureVisibleTab` and persists everything to IndexedDB.
Consecutive clicks on the same page within 8 seconds and no DOM mutation
are grouped into one step. After stopping, the worker opens the editor
page in a new tab; the editor loads the recording, calls Claude in
parallel (4 concurrent calls) for descriptions and titles, and renders
the export in four formats. The WordPress export bakes the annotation
SVG into the PNG via canvas so the visual click-markers survive
clipboard paste.

See `docs/SPEC.md` for the full design.

---

## Distributing to your team

See `docs/DISTRIBUTION-CHECKLIST.md` for the step-by-step process of
publishing CA-Capture as a private extension via Google Workspace.

---

## Development

No build step. Plain ES modules and plain CSS. Reload the extension at
`chrome://extensions/` after editing files.

To inspect logs:
- **Background worker:** `chrome://extensions/` → click "service worker"
  on the CA-Capture card
- **Editor:** open DevTools on the editor tab
- **Content script:** open DevTools on the captured web app's tab
- **Side panel:** open DevTools on the side panel itself (right-click
  inside the panel → Inspect)

---

## Privacy

CA-Capture does not collect telemetry, analytics, or any usage data.
Recordings, screenshots, and API keys are stored locally in the
browser's IndexedDB. The only external service the extension contacts
is Anthropic's Claude API, and only when the user explicitly triggers
an AI action.

See the privacy policy text in `docs/DISTRIBUTION-CHECKLIST.md`
(Appendix 2) for the full statement intended for publishing.

---

## License

Private — internal use at Comparative Agility.
