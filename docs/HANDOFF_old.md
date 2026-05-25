# CA-Capture — Handoff Document

**Purpose:** Drop this into a new Claude chat to continue working on CA-Capture
without re-explaining everything. Includes current state, design decisions,
known issues, and how to resume.

**Current version:** 1.2.1 (May 18, 2026)

---

## How to use this document in a new chat

Paste this whole document at the start of a new chat. A good opening message:

> I'm continuing work on a Chrome extension called CA-Capture. Attached is
> the full context. I also have the source code in a zip — let me know
> when you've read this and I'll upload it.

Then attach `ca-capture-v1.2.1.zip` so Claude can see the actual files.

---

## What CA-Capture is

A Chrome extension (MV3) that records web app workflows and generates
how-to articles with AI. Built for the Comparative Agility help center.

**Core flow:**
1. User clicks the extension icon → Start capture
2. Side panel opens with recording controls (panel docks beside the tab,
   so it doesn't appear in screenshots)
3. User walks through a workflow on any web app
4. Background service worker captures clicks via content script, takes
   screenshots, records a video via offscreen document + MediaRecorder
5. User clicks Stop → editor opens in a new tab
6. Editor shows the recording with AI-generated titles and descriptions
   (Claude API), annotated screenshots, and embedded video
7. User edits, then exports as one of four formats

**Export formats:**
- **Astro help center ZIP** (primary use case — for comparativeagility.com
  help center)
- **Copy for WordPress** (for backup WordPress hosting)
- **Standalone HTML** file
- **HTML + assets bundle** (zip)
- **Embed snippet** (iframe)

---

## Current state — v1.2.1

### Working

- Recording end-to-end (click → screenshot → AI description → export)
- Side panel UI during recording
- All four export formats produce valid output
- Anthropic API integration with parallel processing (4 concurrent
  calls during Rewrite All)
- Recent recordings library page
- IndexedDB persistence
- WordPress export with annotations flattened into PNGs via canvas

### Most recent change (v1.2.1)

- **Fixed:** Editor was blank due to stray `})` at editor.js:307 (left
  over from a metadata-fields edit). Editor now loads normally.
- **Changed:** Astro export folder layout to match the actual HelpDesk-
  Website repo structure. ZIP is now extractable at the repo root.

### Astro export layout (current)

Given a recording with slug `assigning-roles` in category `get-started`:

```
ca-capture ZIP extracted at repo root produces:
src/content/docs/get-started/assigning-roles.md
src/assets/assigning-roles/walkthrough.webm
src/assets/assigning-roles/step-1.png
src/assets/assigning-roles/step-2.png
```

Markdown references images via `../../../assets/<slug>/...` (climbs out
of `docs/<category>/` to `assets/`).

Frontmatter (full spec):
```yaml
---
title: "Article title"
description: "SEO summary."
category: "get-started"
tags:
  - admin
  - roles
sidebar:
  order: 999
published: 2026-05-18
updated: 2026-05-18
---
```

---

## Repository

**On GitHub:** Private repo `ca-capture` under the user's GitHub account.
Coworkers are invited as collaborators. Releases are published with the
zip attached.

**File structure:**
```
ca-capture/
├── README.md
├── .gitignore                          (only in local repo, not in releases)
├── extension/
│   ├── manifest.json                   (v1.2.1)
│   ├── icons/icon-{16,32,128}.png      ("CA" branded)
│   ├── src/
│   │   ├── background.js               service worker, recording state machine
│   │   ├── content.js                  click listener injected into captured tab
│   │   ├── offscreen.{html,js}         MediaRecorder host
│   │   ├── popup.{html,js}             toolbar popup
│   │   ├── recording-panel.{html,css,js}  side panel UI
│   │   ├── db.js                       IndexedDB wrapper
│   │   └── grouping.js                 click grouping
│   └── editor/
│       ├── editor.{html,css,js}        full-page editor
│       ├── ai.js                       prompt templates
│       ├── anthropic.js                API client with retry
│       ├── annotations.js              SVG annotation renderer (shared)
│       ├── flatten.js                  canvas compositing for baked-in annotations
│       ├── export.js                   five export formats
│       ├── zip.js                      hand-rolled stored-only zip builder
│       ├── recent.{html,js}            recordings library page
└── docs/
    ├── SPEC.md                         technical specification
    ├── CHANGELOG.md                    version history
    ├── BUILD-LOG.md                    full conversation transcript through v1.2.0
    ├── DISTRIBUTION-CHECKLIST.md       Workspace publishing steps
    ├── GITHUB-SETUP.md                 GitHub repo setup
    ├── HELPCENTER-EXPORT-SPEC.md       Astro export format spec (original from user)
    └── RELEASE-NOTES-v1.2.0.md, v1.2.1
```

---

## Key architectural decisions

These shape the codebase. If you're modifying something, know these first.

### MV3 (Manifest V3)
Mandatory for new Chrome extensions since 2024. Service workers cannot
run `MediaRecorder` directly — that's why we use offscreen documents.

### Side panel API instead of in-page overlay
`chrome.sidePanel` docks in a reserved area beside the tab.
`captureVisibleTab` only photographs the tab area, so the panel never
appears in screenshots. An in-page overlay would document itself.

**Important:** `chrome.sidePanel` has NO `.close()` API.
`setOptions({ enabled: false })` only affects future opens. To close
the panel from outside, the panel must call `window.close()` on itself.

### IndexedDB instead of chrome.storage
chrome.storage.local has 10MB quota. Screen recordings exceed that easily.
IndexedDB is effectively unlimited for our use case.

### Direct fetch to Anthropic API
`@anthropic-ai/sdk` is Node-flavored, doesn't bundle for browser
extensions. Direct fetch to `/v1/messages` with the
`anthropic-dangerous-direct-browser-access: true` header.

### Click target resolution: elementFromPoint + ancestor scoring
`e.target` returns the deepest element, often a text-node parent or
invisible spacer. We use `document.elementFromPoint(cx, cy)` then walk
up the ancestor chain, scoring each:
- Interactive (button, link, role=*, tabindex, cursor:pointer) → +50
- Has meaningful label → +5
- Penalty for elements < 8px (hidden)
- Penalty for elements > 50% of viewport (full-page wrappers)
- Otherwise prefer smaller area

Then `tightenToVisibleContent()` shrinks wide containers (rows, full-
width buttons) to just the visible text + icons within.

### DPR-aware bounding boxes
HiDPI/Retina captures screenshots at native pixels (e.g. 3200×1800 for
a 1600×900 viewport at DPR 2). DOM rectangles are CSS pixels. The SVG
annotation overlay's viewBox uses the image's native pixel space, so
click rects get **multiplied by DPR** at render time.

### Bounding boxes stored in viewport CSS pixels (no scroll offset)
`captureVisibleTab` only captures the viewport, not the full document.
Storing pure viewport coordinates means annotations align regardless
of scroll position.

### Callouts only when label not visible
If the click target's text is already on the page, a callout pill
showing the same text is redundant. We track `label_visible` at click
time; callouts only show for icon-only buttons. Numbered pins removed
entirely in v1.0.

### Parallel AI calls (concurrency = 4)
Worker-pool pattern: 4 workers pull from a shared queue. Anthropic's
rate limits are generous; 4 gives 5-10× speedup on long rewrites
without rate-limit risk.

### Canvas-flattened annotations for WordPress and Astro
Pure SVG overlays don't survive clipboard paste or static-site
rendering. We composite screenshot + annotation SVG onto a canvas via
`new Image()` from a data URL, export as PNG blob. Annotations become
part of the image.

### Hand-rolled zip (stored-only, no deflate)
JSZip is ~100KB. Our needs (PNG/WebM, already compressed) are tiny — a
126-line implementation handles it. No dependencies.

---

## Known issues / open items

### Not implemented yet

1. **Worker upload to help-uploader** (Cloudflare Worker for direct upload
   to GitHub). Spec has it; user deferred until Worker is deployed. When
   ready: ~20 lines added to the existing Astro export flow.

2. **Category list fetching.** Currently shows hardcoded 10 spec
   categories as a datalist dropdown with custom typing allowed. User
   wants to fetch from a source eventually (likely GitHub raw URL or
   live site sitemap) so categories stay in sync with the repo.

3. **Image co-located vs centralized.** User chose centralized
   (`src/assets/<slug>/`) in v1.2.1. If the Astro repo convention
   changes, this is a one-place fix in `export.js`.

### Deferred/future work

- **iframe and shadow DOM clicks** — content script doesn't reach
  inside them. Plan: detect "no click event within 200ms of focus
  change" and show a toast.
- **Brand color theming** — annotation colors hardcoded blue.
- **Redact tool** — black out sensitive regions before export.
- **Multi-tab workflows** — single-tab only in v1.

---

## Distribution status

**Currently shipping as:** unpacked extension via private GitHub
releases. Coworkers download zip, unzip, `chrome://extensions/` →
Load unpacked → select `extension/` folder.

**Next step (deferred):** publish to Chrome Web Store as a private
domain extension via Google Workspace. `docs/DISTRIBUTION-CHECKLIST.md`
has the step-by-step. Requires:
- Workspace admin to enable private publishing
- $5 developer registration
- ~30 min first submission, 24-48 hr review

User's coworkers are non-technical. Once published privately, they get
"Add to Chrome" button and auto-updates.

---

## How the user works

A few things to know about the working relationship:

- **The user is non-technical but capable.** They follow instructions
  well, send screenshots and console errors when things break, and
  push back when a recommendation feels wrong.

- **They prefer to confirm before changes.** Before building anything
  non-trivial, ask via the questions tool. They especially appreciated
  this for choices like:
  - Annotation styles (pin vs callout)
  - AI parallelization approach
  - WordPress HTML strategy (minimal semantic vs styled)
  - Astro folder layout

- **They want explanations of trade-offs, not just answers.** When
  asked something like "which approach should I use", explain options
  ranked by recommendation with pros/cons, then ask.

- **Run a syntax check before every package.** This was learned the
  hard way — v1.2.0 shipped with a stray `})` that made the editor
  blank. Lesson learned: `for f in $(find extension -name '*.js'); do
  node --check "$f"; done` before zipping.

- **Bugs to watch for:**
  - User-gesture loss (`sidePanel.open()` needs to be the very first
    thing in a click handler, before any `await`)
  - DPR/scroll coordinate mismatches in annotations
  - `chrome.sidePanel` has no close API — panel must close itself
  - Service workers can't reliably fetch `data:` URLs in some Chrome
    versions — decode base64 manually

---

## Quick reference — file paths to remember

**Source of truth for state machine:** `extension/src/background.js`
**Where the click resolver lives:** `extension/src/content.js`,
function `resolveClickTarget` + `tightenToVisibleContent`
**Where annotations are rendered:** `extension/editor/annotations.js`
(SVG generation) and `extension/editor/flatten.js` (canvas baking)
**Where the exports live:** `extension/editor/export.js` — five
exports: `exportStandalone`, `exportBundle`, `exportEmbedSnippet`,
`exportWordPress`, `exportAstro`
**Editor entry point:** `extension/editor/editor.js`,
function `main()` at the top

---

## Resuming work

To continue, you typically want to:

1. **Open the user's repo** (clone from their private GitHub if they
   share a link, or work from the uploaded zip)
2. **Read `docs/SPEC.md` and `docs/CHANGELOG.md`** to confirm current state
3. **Check current bugs** if user reports something — usually the
   console error pinpoints the file and line
4. **Make changes incrementally** — small str_replaces, syntax check
   after each substantial edit, package once at the end
5. **Update CHANGELOG.md and bump manifest version** on every change
6. **Single zip output** named `ca-capture-v<version>.zip` (user uses
   one zip both for repo seeding and release attachment)

---

## Last conversation summary

The most recent series of changes:

1. **WordPress export added** (v1.1) — minimal semantic HTML, flattened
   annotations, copy-to-clipboard. User switched step heading to `<h4>`
   for their theme.

2. **Parallelization** (v1.1.2) — Rewrite All went from sequential
   (20-30s for 10 steps) to 4 concurrent (6-8s). Left rail also now
   updates after completion.

3. **GitHub setup** — user created private repo, added coworkers as
   collaborators. Distribution checklist for future Workspace publish.

4. **Astro export** (v1.2.0) — built for the comparativeagility.com help
   center. Frontmatter + Markdown + flattened PNGs. Initially produced
   `<slug>/index.md` layout per spec.

5. **Layout fix** (v1.2.1) — user clarified actual repo structure is
   `<category>/<slug>.md` flat with images at `src/assets/<slug>/`.
   Updated the export to produce that layout. ZIP is now meant to be
   extracted at the repo root.

6. **Blank-editor bug fix** (v1.2.1) — stray `})` left over from earlier
   edit caused syntax error. Editor now loads.

---

## Pending questions the user might raise

- **Category fetching:** the user said "we will deal with this some
  other time". Likely the next request will be to fetch from GitHub
  raw URL or a published JSON file.

- **Worker upload:** the Cloudflare Worker for direct upload to GitHub
  is in the spec but deferred. If user mentions it's deployed, we add
  ~20 lines.

- **Testing the v1.2.1 fix:** user is about to test the editor after
  the syntax error fix. If it works, we move on. If not, console
  errors will tell us what else is wrong.

- **WordPress export adjustment:** still possible the user wants more
  changes there — minor styling tweaks, different heading levels, etc.

---

## End of handoff
