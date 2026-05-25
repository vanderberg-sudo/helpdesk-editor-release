# CA-Capture & Help Center — Decisions, Rules & New Chat Guide

**Last updated:** May 2026

This document captures why things were built the way they were, the working rules established during development, and everything needed to resume work in a new chat without losing context.

---

## How to start a new chat

Paste this at the start of a new conversation:

> I'm working on CA-Capture, a Chrome extension that records web workflows and publishes how-to articles to a Starlight/Astro help center hosted on Cloudflare Pages. The repo is vanderberg-sudo/HelpDesk-Website. A Cloudflare Worker (help-uploader) handles uploads and deletions via the GitHub Git Data API. Read ARCHITECTURE.md for the full system. Read DECISIONS.md for working rules. Key rule: always confirm the plan before writing any code, and deliver files individually (no ZIP).

Then attach both `ARCHITECTURE.md` and `DECISIONS.md`.

---

## Working rules (established during development)

These rules were set explicitly and must be followed in every session:

### 1. Confirm before building
Always present a plan — what files will be created/changed and why — and wait for explicit confirmation before writing any code. Do not start building speculatively.

### 2. Deliver files individually, not as ZIPs
Share each file separately so the developer can copy/paste directly. Never bundle deliverables into a ZIP. ZIPs require extraction and make it harder to review individual changes.

### 3. Limit changes to the minimum necessary files
When adding a feature, create new files where possible rather than modifying existing ones. When modification is unavoidable, make surgical targeted changes. The smaller the diff, the easier debugging is.

### 4. New features go in new modules
Example: upload logic went into `upload.js`, not into `editor.js`. Management UI went into `manage.html` / `manage.js`. This keeps each file focused and debuggable in isolation.

### 5. No behaviour changes without examples
For the click capture / annotation accuracy work (`capture.js`), do not rewrite heuristics without concrete failing examples. Guesswork risks breaking cases that currently work.

### 6. Pure functions in isolation
`capture.js` contains only pure DOM analysis functions with no Chrome API calls or recording state. This makes it independently testable. Maintain this separation.

### 7. Code will be reviewed by experienced developers and other LLMs
Write production-quality code. Comment intent, not mechanics. Keep functions focused. No shortcuts.

---

## Key architectural decisions and rationale

### Why the Git Data API instead of the Contents API for GitHub commits

The GitHub Contents API (`PUT /repos/.../contents/{path}`) commits one file at a time. Each commit triggers a Cloudflare Pages build. When an article has 4 images + 1 MDX file, that's 5 separate commits → 5 build triggers → Astro tries to build after the first commit (the MDX) but the images don't exist yet → build fails with "Could not resolve ./assets/...".

The Git Data API creates one tree containing all files and pushes everything as a single commit → one build trigger → all files present. This is not optional — switching back to the Contents API will break multi-file articles.

### Why atomic deletes use the same Git Data API

Same reason. Deleting a file via the Contents API is one file at a time. Setting `sha: null` on tree entries via the Git Data API deletes all files in one commit.

### Why the Worker exists at all (why not push directly from the extension to GitHub)

- The `GITHUB_TOKEN` never leaves the Worker's secret store. If the extension talked to GitHub directly, the token would have to be stored in the extension — where any user could extract it from Chrome's devtools.
- The Worker validates category slugs, frontmatter fields, and file references before committing. Bad data never reaches the repo.
- Rate limiting lives in the Worker, not distributed across clients.

### Why content-index.json is generated at build time (not queried from GitHub API)

- No auth required — it's a public static file, same as a sitemap.
- Always accurate — it reflects exactly what's in the built site, not what's in the repo (which could include in-progress articles).
- Zero latency — served from Cloudflare's CDN edge, not a GitHub API round-trip.
- Free — no GitHub API quota consumed.

### Why the Manage screen is a full page, not a modal

The help center will grow to 200-300 articles across 10 categories. A modal is too cramped for that volume. A full browser tab gives proper scrolling, keyboard navigation, and room to show title + description + metadata for each article.

### Why deleted articles can stay cached for ~2 hours

Cloudflare CDN caches built HTML at the edge. After a successful build, old cached responses for removed pages can persist for up to ~2 hours. The fix would be to call the Cloudflare Cache Purge API after every delete — which requires a Cloudflare API token with Cache Purge permissions stored as a Worker secret. The trade-off (complexity + extra secret vs 2-hour cache lag) was evaluated and the cache lag accepted. If this becomes a real problem for users, add the purge call then.

### Why capture.js was extracted from content.js

`content.js` was a single 380-line file mixing Chrome extension machinery (message listeners, screenshot timing, indicator rendering) with pure DOM analysis logic (`resolveClickTarget`, `tightenToVisibleContent`, etc.). The DOM analysis functions are the ones most likely to need improvement as annotation accuracy issues are collected. Extracting them into `capture.js` means:

- They can be tested in isolation (no Chrome APIs, no recording state)
- Changes to annotation logic don't risk breaking the recording pipeline
- `content.js` is now 152 lines, focused on recording machinery only

### Why success and error notifications don't auto-dismiss

During testing, the success banner auto-dismissed after 30 seconds and the error modal closed if you clicked the backdrop. Both were changed to require explicit ✕ click because:

- Authors need time to copy the article URL from the success banner
- Error messages need to be read and acted on — dismissing them accidentally by clicking outside is frustrating

### Why manage.js checks for the shared secret before fetching articles

If the shared secret isn't configured, the Delete button would silently fail at the Worker (401). Checking upfront gives a clear actionable error ("go to Settings and add your secret") before the author tries to delete something.

---

## Things that were tried and rejected

### GitHub Contents API for multi-file commits
Tried first. Failed because each file commit triggers a separate build. Replaced with Git Data API.

### Auto-dismissing notifications
Tried. Caused frustration — authors missed the article URL and couldn't re-read errors. Removed.

### Backdrop-click to close error modal
Tried. Authors accidentally dismissed errors while trying to scroll or read. Removed.

### Single ZIP delivery for code changes
Used early in the session. Switched to individual files because ZIPs require extraction and make it harder to verify exactly what changed.

### Debug version of the Worker
Built a temporary version that exposed `owner=..., repo=..., token=ghp_xx...` in error messages to diagnose a GitHub 404. Useful for debugging — the pattern (include env var presence in error output) is worth remembering for future Worker issues.

---

## Extension file delivery rules

When delivering changes to the extension, provide each changed file separately with its exact destination path:

| File | Destination in extension folder |
|------|--------------------------------|
| `content.js` | `extension/src/content.js` |
| `capture.js` | `extension/src/capture.js` (new file) |
| `editor.js` | `extension/editor/editor.js` |
| `editor.html` | `extension/editor/editor.html` |
| `upload.js` | `extension/editor/upload.js` |
| `manage.html` | `extension/editor/manage.html` (new file) |
| `manage.js` | `extension/editor/manage.js` (new file) |

Never deliver as a ZIP. Always state the destination path clearly.

---

## Website file delivery rules

When delivering changes to the website repo, provide each file separately with its path relative to the repo root:

| File | Destination |
|------|-------------|
| `astro.config.mjs` | repo root |
| `content-index.json.ts` | `src/pages/content-index.json.ts` |
| Any article `.mdx` | `src/content/docs/<category>/<slug>.mdx` |

After copying files, the developer commits via GitHub Desktop and pushes. Cloudflare Pages rebuilds automatically.

---

## Worker delivery rules

The Worker is a single file. Deliver it as `worker-index.js` (or similar) and instruct the developer to:

1. Go to Cloudflare → Workers & Pages → `help-uploader` → Edit code
2. Select all, delete, paste the new code
3. Click Deploy

No wrangler CLI is used — all Worker deployments are done via the Cloudflare dashboard editor.

---

## Known issues / future work

| Issue | Status | Notes |
|-------|--------|-------|
| Annotation accuracy ("off" bounding boxes) | Pending | Waiting to collect failing examples before changing `capture.js` heuristics |
| Deleted article pages cached for ~2 hours | Accepted | Cache purge API would fix it; complexity not worth it yet |
| `help.comparativeagility.com` custom domain not connected | Pending | Requires DNS change pointing subdomain to Cloudflare Pages |
| WordPress article migration (~131 articles) | Not started | One-time script via WordPress REST API → Markdown |
| `manage.html` not in `web_accessible_resources` in manifest.json | Needs fix | Add `editor/manage.html` to the `web_accessible_resources` array in `manifest.json` |

---

## manifest.json — items to keep in sync

When adding new extension pages, add them to `web_accessible_resources` in `manifest.json`. Currently listed:

```json
"web_accessible_resources": [
  {
    "resources": [
      "editor/editor.html",
      "editor/recent.html",
      "editor/manage.html",
      "src/recording-panel.html",
      "src/recording-panel.css",
      "src/recording-panel.js",
      "icons/*"
    ],
    "matches": ["<all_urls>"]
  }
]
```

Note: `editor/manage.html` was added as part of the Manage feature. Verify it is present.

---

## Glossary

| Term | Meaning |
|------|---------|
| CA-Capture | The Chrome extension (internal name: StepCast in older code) |
| Step | A single recorded click with its screenshot |
| Group | One or more steps that belong to the same logical action |
| Slug | URL-safe article identifier, e.g. `assigning-roles` |
| Worker | The Cloudflare Worker (`help-uploader`) that proxies GitHub writes |
| MDX | Markdown with JSX — the article format Astro/Starlight uses |
| Atomic commit | A single Git commit containing all files for an article — prevents partial builds |
| content-index.json | Build-time static JSON listing all published articles |
| SHARED_SECRET | The bearer token authenticating the extension to the Worker |
