# CA-Capture & Help Center — System Architecture

**Last updated:** May 2026  
**Status:** Production

This document describes the full system as it exists today. Read this first when starting a new chat or onboarding someone new.

---

## System overview

```
CA-Capture (Chrome extension)
        │
        │  multipart/form-data POST (ZIP file)
        ▼
Cloudflare Worker  (help-uploader)
        │
        │  GitHub Git Data API  (atomic commit)
        ▼
GitHub Repository  (vanderberg-sudo/HelpDesk-Website)
        │
        │  webhook (auto-triggered on every push to main)
        ▼
Cloudflare Pages   (builds the Astro site)
        │
        │  ~60-90 seconds
        ▼
Live site:  https://helpdesk-website.pages.dev
```

---

## Component 1 — CA-Capture Chrome extension

**Purpose:** Records a user's clicks on a web app, generates step-by-step how-to articles, and publishes them to the help center.

**Location:** Developer's local machine. Loaded as an unpacked extension in Chrome.

**Key files and their roles:**

| File | Role |
|------|------|
| `src/background.js` | Service worker. Orchestrates recording state, takes screenshots via `captureVisibleTab`, persists steps to IndexedDB |
| `src/content.js` | Injected into the recorded tab. Listens for clicks and sends metadata to background |
| `src/capture.js` | **Pure functions only** — `resolveClickTarget`, `tightenToVisibleContent`, `isInteractiveElement`, `labelFor`, `cssPath`. No Chrome APIs. Isolated so it can be tested and improved independently |
| `src/grouping.js` | Pure function `decideGrouping` — decides whether a click belongs to the current step or starts a new one |
| `src/db.js` | IndexedDB wrapper — stores recordings, steps, and blobs (screenshots, video) |
| `src/offscreen.js` | Owns the `MediaRecorder` for tab video capture (service workers can't use MediaRecorder) |
| `src/popup.js` | Toolbar popup — start/stop recording |
| `src/recording-panel.js` | Chrome side panel shown alongside the recorded tab during recording |
| `editor/editor.js` | Main editor — loads recording from IndexedDB, renders steps, handles AI generation |
| `editor/editor.html` | Editor UI — topbar with Preview / Publish / Manage / Share & export buttons |
| `editor/export.js` | All export formats including `exportAstro()` which builds the ZIP the Worker expects |
| `editor/upload.js` | Publish logic — reads shared secret, calls `exportAstro`, POSTs to Worker, handles 409 conflict |
| `editor/manage.html` | Full-screen article management page (opened as new tab from Manage button) |
| `editor/manage.js` | Fetches `content-index.json`, renders articles by category, handles delete via Worker |
| `editor/ai.js` | AI title/description generation via Anthropic API |
| `editor/anthropic.js` | Anthropic API client — reads API key from `chrome.storage.local` |
| `editor/annotations.js` | Renders click annotations (highlight boxes) on screenshots |
| `editor/recent.html/js` | Lists recent recordings |
| `editor/zip.js` | ZIP file builder used by `exportAstro` |
| `editor/flatten.js` | Flattens step groups for export |

**Chrome storage:**

| Key | Storage | Value |
|-----|---------|-------|
| `stepcast_api_key` | `chrome.storage.local` | Anthropic API key |
| `helpdesk_shared_secret` | `chrome.storage.local` | Shared secret for Worker auth |

**Permissions:** `activeTab`, `scripting`, `storage`, `tabCapture`, `tabs`, `offscreen`, `sidePanel`, `<all_urls>`

**manifest.json version:** 3  
**Extension version:** 1.2.1

---

## Component 2 — Cloudflare Worker (help-uploader)

**Purpose:** Receives article ZIPs from the extension and commits them to GitHub atomically. Also handles article deletion.

**Worker URL:** `https://help-uploader.almir-970.workers.dev`

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/upload` | Publish a new or updated article |
| `DELETE` | `/article` | Delete an article and all its assets |
| `OPTIONS` | `*` | CORS preflight |

**POST /upload — request format:**
```
Content-Type: multipart/form-data
Authorization: Bearer <SHARED_SECRET>

Fields:
  file      — ZIP binary (produced by exportAstro())
  category  — string  e.g. "get-started"
  action    — "create" | "update"
```

**DELETE /article — request format:**
```
Content-Type: application/json
Authorization: Bearer <SHARED_SECRET>

Body: { "category": "instant-insights", "slug": "my-article" }
```

**Authentication:** Bearer token checked against `SHARED_SECRET` env variable on every request.

**Rate limiting:** Max 20 uploads per hour per token (in-memory, resets on Worker restart).

**Environment variables (set in Cloudflare dashboard as Secrets/Plaintext):**

| Name | Type | Value |
|------|------|-------|
| `SHARED_SECRET` | Secret | Random string — must match extension setting |
| `GITHUB_TOKEN` | Secret | GitHub PAT with `repo` scope |
| `GITHUB_OWNER` | Plaintext | `vanderberg-sudo` |
| `GITHUB_REPO` | Plaintext | `HelpDesk-Website` |

**GitHub commit strategy:** Uses the Git Data API (not Contents API) to push all files in one atomic commit. This is critical — the Contents API commits one file at a time, triggering a Cloudflare Pages build after each file. The Git Data API bundles everything into a single commit → single build trigger → all files present when Astro builds.

**ZIP layout the Worker expects:**
```
src/content/docs/<category>/<slug>.mdx
src/content/docs/<category>/assets/<slug>/step-1.png
src/content/docs/<category>/assets/<slug>/walkthrough.webm
```

**Valid category slugs:**
`get-started`, `advanced-topics`, `general`, `account`, `billing`, `feedback-360`, `instant-insights`, `personal-improvement`, `privacy-legal`, `reports`

**Worker version:** v3 (current)  
**Cloudflare account subdomain:** `almir-970.workers.dev`

---

## Component 3 — GitHub Repository

**Repo:** `vanderberg-sudo/HelpDesk-Website` (private)  
**Branch:** `main` (only branch — no PRs, no staging)  
**Webhook:** Cloudflare Pages watches `main` and rebuilds on every push automatically.

**Repository layout:**
```
HelpDesk-Website/
├── astro.config.mjs           — Site config (sidebar categories, components)
├── package.json               — Dependencies (Astro 5.x, Starlight 0.36.x, sharp)
├── tsconfig.json
├── public/
│   └── llms.txt               — AI crawler hints
├── src/
│   ├── assets/                — Logo SVGs (logo-light.svg, logo-dark.svg)
│   ├── components/            — Custom Astro components overriding Starlight defaults
│   │   ├── Head.astro
│   │   ├── Hero.astro
│   │   ├── PageFrame.astro
│   │   └── PageTitle.astro
│   ├── content.config.ts      — Starlight content schema
│   ├── content/docs/          — All articles by category
│   │   ├── index.mdx          — Homepage
│   │   ├── get-started/
│   │   ├── instant-insights/
│   │   │   ├── assets/
│   │   │   │   └── <slug>/    — Images/video for each article
│   │   │   └── <slug>.mdx
│   │   └── ... (one folder per category)
│   ├── pages/
│   │   └── content-index.json.ts  — Build-time JSON endpoint
│   └── styles/
│       └── custom.css         — Custom theme (shadcn/Lucode-inspired)
└── info/                      — Project notes (not served by Astro)
```

---

## Component 4 — Cloudflare Pages (helpdesk-website)

**Project name:** `helpdesk-website`  
**Production URL:** `https://helpdesk-website.pages.dev`  
**Future custom domain:** `https://help.comparativeagility.com` *(not yet connected)*  
**GitHub repo:** `vanderberg-sudo/HelpDesk-Website`

**Build configuration:**

| Setting | Value |
|---------|-------|
| Framework preset | Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | (blank) |
| Production branch | `main` |
| `NODE_VERSION` env var | `20` |

**Important:** `NODE_VERSION=20` must be set as a plaintext variable. Without it Cloudflare picks the wrong Node version and the build fails.

**Build time:** ~60-90 seconds from git push to live.

**Cache behaviour:** After a successful build, Cloudflare CDN can serve previously-built pages from cache for up to ~1-2 hours even if those pages were removed in the latest build. This is expected behaviour — deleted articles will disappear naturally within that window.

---

## Component 5 — content-index.json endpoint

**URL:** `https://helpdesk-website.pages.dev/content-index.json`  
**Source file:** `src/pages/content-index.json.ts`  
**Generated at:** build time (static, no server needed)  
**Auth:** None — public endpoint

**Purpose:** Provides a machine-readable list of all published articles for the Manage screen in the extension. The extension fetches this to list articles grouped by category.

**Response shape:**
```json
{
  "generated": "2026-05-19T22:00:00Z",
  "total": 42,
  "articles": [
    {
      "slug": "assigning-roles",
      "category": "get-started",
      "title": "Assigning roles",
      "description": "...",
      "url": "/get-started/assigning-roles/",
      "lastUpdated": "2026-05-17",
      "sidebarOrder": 1
    }
  ]
}
```

---

## Article frontmatter format (.mdx)

Every article starts with a YAML frontmatter block:

```yaml
---
title: "Article title"
description: "One sentence. Under 160 characters."
category: "instant-insights"
sidebar:
  order: 1
lastUpdated: 2026-05-17
---
```

Required fields: `title`, `description`, `category`  
Optional fields: `sidebar.order` (default 999, appended at end), `lastUpdated`

---

## Data flow — publishing an article

1. Author records workflow in CA-Capture
2. Author clicks **Publish** in the editor
3. `upload.js` reads `helpdesk_shared_secret` from `chrome.storage.local`
4. `upload.js` calls `exportAstro()` which builds a ZIP with the correct repo-relative paths
5. `upload.js` POSTs the ZIP to `https://help-uploader.almir-970.workers.dev/upload`
6. Worker validates auth, unpacks ZIP, validates frontmatter
7. Worker checks if article exists (409 if it does and action=create)
8. Worker creates blobs for each file via GitHub Git Data API
9. Worker creates one tree + one commit + updates `main` ref — all atomic
10. GitHub push triggers Cloudflare Pages build webhook
11. Cloudflare builds and deploys (~90 seconds)
12. Extension shows green success banner with live article link

**On 409 conflict:** Extension shows confirmation dialog. If author confirms, resends with `action=update`.

---

## Data flow — deleting an article

1. Author clicks **Manage** in the editor — opens `manage.html` in new tab
2. `manage.js` fetches `content-index.json` from live site
3. Author clicks **Delete** → confirm prompt
4. `manage.js` sends `DELETE /article` to Worker with `{ category, slug }`
5. Worker fetches full repo tree, finds all files for the article
6. Worker creates a new tree with those file entries set to `null` (Git deletion)
7. Single commit pushed to `main` → single build trigger
8. Cloudflare rebuilds — article disappears from sidebar and index
9. Previously-built HTML for that URL may stay cached for up to ~2 hours (expected, no fix needed)

---

## Accounts & access

| Resource | Account |
|----------|---------|
| GitHub repo | `vanderberg-sudo` (vanderberg@gmail.com) |
| Cloudflare | Almir@comparativeagility.com |
| Cloudflare account ID | `9704f13acdc14eb8daef144af6f6...` (see dashboard) |
| Cloudflare subdomain | `almir-970.workers.dev` |

---

## Monthly cost

**$0** — Cloudflare Pages free tier (unlimited bandwidth/requests, 500 builds/month), GitHub free tier.
