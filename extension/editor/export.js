// export.js — Generates the three export formats from a recording.
//
// We render the article HTML once, with all the same structure regardless
// of format. The format choice only changes how assets are referenced:
//   - standalone:  base64 data URIs inline
//   - bundle:      ./assets/<file> references, zipped together
//   - embed:       points at the user's hosted standalone HTML

import { getBlob } from '../src/db.js';
import { renderAnnotationsSvg, getImageDimensions } from './annotations.js';

/**
 * Build the article HTML.
 * @param {object} opts
 *   recording: the recording record
 *   groups: array of step groups (each = array of steps)
 *   assetResolver: (blob_id, type) => string  // returns src URL for image/video
 */
export async function renderArticleHtml(opts) {
  const { recording, groups, assetResolver } = opts;

  const meta = recording.meta || {};
  const videoSrc = (recording.video_blob_id && !meta.hide_video)
    ? await assetResolver(recording.video_blob_id, 'video') : null;

  const stepsHtml = await Promise.all(groups.map((group, idx) => renderStep(group, idx + 1, assetResolver)));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(recording.title || 'How-to')}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<article class="stepcast-article">
  <header>
    <div class="breadcrumb"><span>Help Center</span> › <span>${escapeHtml(recording.title || 'How-to')}</span></div>
    <h1>${escapeHtml(recording.title || 'Untitled')}</h1>
    <div class="meta">
      <span>${groups.length} step${groups.length === 1 ? '' : 's'}</span>
      <span>·</span>
      <span>Created ${new Date(recording.created_at).toLocaleDateString()}</span>
    </div>
  </header>

  ${videoSrc ? `
  <section class="video-section">
    <video controls src="${escapeAttr(videoSrc)}"></video>
  </section>` : ''}

  <section class="steps">
    ${stepsHtml.join('\n')}
  </section>
</article>
</body>
</html>`;
}

async function renderStep(group, stepNumber, assetResolver) {
  // The group is an array of steps that share a screenshot context.
  // First step's screenshot is the canonical one; pins come from all steps' bounding boxes.
  const primary = group[0];
  const hasScreenshot = !!primary.screenshot_blob_id;
  const screenshotSrc = hasScreenshot ? await assetResolver(primary.screenshot_blob_id, 'screenshot') : '';
  const title = primary.user_title || primary.ai_title || titleFromGroup(group);
  const description = primary.user_description || primary.ai_description || '';

  // Get the actual screenshot dimensions so the SVG overlay's coordinate
  // space matches. Skip for manual steps that have no screenshot.
  const blob = hasScreenshot ? await getBlob(primary.screenshot_blob_id) : null;
  const dims = await getImageDimensions(blob);

  // Click bounding boxes are stored in CSS pixel viewport coordinates.
  // Scale by device_pixel_ratio (recorded at click time) to match the
  // screenshot's native pixel dimensions.
  const clicks = group
    .filter(s => s.click.bounding_box)   // manual steps have no bounding box
    .map(s => {
      const dpr = s.click.device_pixel_ratio || 1;
      const b = s.click.bounding_box;
      const showCallout = s.click.label_visible === false;
      return {
        bounding_box: { x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr },
        label: s.user_title || s.click.element_label || '',
        show_callout: showCallout,
      };
    });
  const annotationsSvg = renderAnnotationsSvg({
    width: dims.width,
    height: dims.height,
    clicks,
  });

  const substepsList = group.length > 1 ? `
    <ol class="substeps">
      ${group.map((s, i) => `<li><span class="pin-num">${i + 1}</span>${escapeHtml(s.user_description || s.ai_description || `Click ${s.click.element_label}`)}</li>`).join('')}
    </ol>
  ` : '';

  const hidden = primary.hidden || {};
  return `
    <div class="step">
      <div class="step-num">${stepNumber}</div>
      <div class="step-body">
        ${hidden.title ? '' : `<h2>${escapeHtml(title)}</h2>`}
        ${(!hidden.description && description) ? renderMarkdown(description) : ''}
        ${(!hidden.image && screenshotSrc) ? `
        <div class="step-screenshot">
          <img src="${escapeAttr(screenshotSrc)}" alt="${escapeAttr(title)}">
          <div class="annotations-overlay">${annotationsSvg}</div>
        </div>` : ''}
        ${substepsList}
      </div>
    </div>`;
}

function titleFromGroup(group) {
  return group.length === 1
    ? `Click ${group[0].click.element_label}`
    : `Step with ${group.length} clicks`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

const BASE_CSS = `
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f8f7f4; color: #1f1f1d; line-height: 1.6; }
  .stepcast-article { max-width: 760px; margin: 40px auto; background: white;
         border-radius: 12px; border: 0.5px solid rgba(0,0,0,0.1); overflow: hidden; }
  header { padding: 32px 40px 20px; border-bottom: 0.5px solid rgba(0,0,0,0.1); }
  .breadcrumb { font-size: 12px; color: #888780; margin-bottom: 12px; }
  h1 { font-size: 26px; margin: 0 0 10px; font-weight: 500; line-height: 1.25; }
  .meta { font-size: 12px; color: #888780; display: flex; gap: 8px; }
  .video-section { padding: 20px 40px; }
  .video-section video { width: 100%; border-radius: 8px; background: #1a1a1a; }
  .steps { padding: 24px 40px 40px; }
  .step { display: flex; gap: 20px; margin-bottom: 36px; }
  .step-num { flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%;
              background: #e6f1fb; color: #185fa5; display: flex; align-items: center;
              justify-content: center; font-weight: 500; font-size: 14px; }
  .step-body { flex: 1; min-width: 0; }
  .step-body h2 { font-size: 17px; margin: 4px 0 8px; font-weight: 500; }
  .step-body p { font-size: 14px; color: #5f5e5a; margin: 0 0 16px; }
  .step-screenshot { position: relative; background: #f8f7f4;
                     border: 0.5px solid rgba(0,0,0,0.1); border-radius: 8px;
                     padding: 14px; }
  .step-screenshot img { width: 100%; height: auto; display: block; border-radius: 4px; }
  .step-screenshot .annotations-overlay {
    position: absolute; left: 14px; top: 14px; right: 14px; bottom: 14px;
    pointer-events: none;
  }
  .step-screenshot .annotations-overlay svg {
    width: 100%; height: 100%; display: block;
  }
  .substeps { padding-left: 0; list-style: none; margin: 16px 0 0; }
  .md-callout { border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
  .md-callout--tip, .md-callout--note { background: #f0effe; border-left: 3px solid #7c72e8; }
  .md-callout--caution, .md-callout--danger { background: #fff3f0; border-left: 3px solid #e85a4f; }
  .md-callout-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; color: #4a3f9f; }
  .md-callout--caution .md-callout-label, .md-callout--danger .md-callout-label { color: #b83c35; }
  .md-callout-body { font-size: 14px; line-height: 1.6; color: #3d3869; }
  .md-callout--caution .md-callout-body, .md-callout--danger .md-callout-body { color: #7a2d29; }
  a { color: #4a6cf7; }
  .substeps li { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0;
                 font-size: 13px; color: #5f5e5a; }
  .pin-num { flex-shrink: 0; width: 18px; height: 18px; border-radius: 50%;
             background: #e6f1fb; color: #185fa5; font-size: 10px; font-weight: 600;
             text-align: center; line-height: 18px; }
`;

// ---- Markdown renderer ----
//
// Converts the lightweight markdown subset used in step descriptions to HTML.
// Handles: **bold**, *italic*, `code`, [text](url) / [text](url "_blank"),
// and :::tip\n...\n::: callout blocks (Starlight syntax).
// Used by standalone and WordPress exports. Astro MDX handles markdown natively.

function renderMarkdown(str) {
  if (!str) return '';
  const lines  = str.split('\n');
  const blocks = [];
  let   i      = 0;
  while (i < lines.length) {
    const line = lines[i];
    // :::tip ... ::: callout block
    if (line.trim().startsWith(':::')) {
      const typeMatch = line.trim().match(/^:::([a-z]+)/);
      const tipType   = typeMatch ? typeMatch[1] : 'tip';
      const bodyLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(':::')) {
        bodyLines.push(lines[i]);
        i++;
      }
      i++; // skip closing :::
      const label = tipType.charAt(0).toUpperCase() + tipType.slice(1);
      blocks.push(
        `<div class="md-callout md-callout--${tipType}">` +
        `<div class="md-callout-label">${label}</div>` +
        `<div class="md-callout-body">${inlineMarkdown(bodyLines.join('\n'))}</div>` +
        `</div>`
      );
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith(':::')) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) blocks.push(`<p>${inlineMarkdown(paraLines.join(' '))}</p>`);
  }
  return blocks.join('\n');
}

function inlineMarkdown(str) {
  return str
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    // Link with _blank hint: [text](url "_blank")
    .replace(/\[([^\]]+)\]\(([^)]+)\s+"_blank"\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Link without hint — always open in new tab
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// ---- Format-specific generation ----

export async function exportStandalone(recording, groups) {
  // Convert all blobs to data: URIs
  const resolver = async (blob_id) => {
    const blob = await getBlob(blob_id);
    if (!blob) return '';
    return await blobToDataUrl(blob);
  };
  return renderArticleHtml({ recording, groups, assetResolver: resolver });
}

export async function exportBundle(recording, groups) {
  // Returns a Map of filename → Blob/string for zipping.
  const files = new Map();
  const slug = slugify(recording.title || 'how-to');

  const resolver = async (blob_id, type) => {
    const blob = await getBlob(blob_id);
    if (!blob) return '';
    const filename = type === 'video'
      ? `assets/video.webm`
      : `assets/${blob_id.slice(0, 8)}.png`;
    files.set(filename, blob);
    return `./${filename}`;
  };

  const html = await renderArticleHtml({ recording, groups, assetResolver: resolver });
  files.set('index.html', new Blob([html], { type: 'text/html' }));
  return { files, slug };
}

export function exportEmbedSnippet(recording, host_url) {
  const slug = slugify(recording.title || 'how-to');
  return `<!-- CA-Capture embed -->
<iframe src="${host_url}/${slug}/index.html"
        width="100%" height="800"
        style="border: 0; border-radius: 12px;"
        loading="lazy"
        title="${escapeHtml(recording.title)}"></iframe>`;
}

// ---- WordPress export ----
//
// Builds minimal semantic HTML suitable for pasting into the WordPress
// editor (either the visual editor or the HTML/Code view). The output uses
// only standard tags (h1, h4, p, ol, li, figure, img, video) with NO inline
// styles or class names — WordPress's theme styles take over completely.
//
// Each screenshot has its annotations (outline, dim spotlight, label callout)
// baked into the PNG via canvas, so the visual click-marker survives even
// though WordPress strips SVG overlays.
//
// Returns a single HTML string ready to copy to clipboard.

import { flattenAnnotatedScreenshot, blobToDataUrl as blobToDataUrlInline } from './flatten.js';

export async function exportWordPress(recording, groups, options = {}) {
  const { includeVideo = true, onProgress } = options;

  const parts = [];

  // Title and intro
  parts.push(`<h1>${escapeHtml(recording.title || 'How-to')}</h1>`);
  parts.push(''); // blank line for readability when pasted

  // Video at the top (optional)
  if (includeVideo && recording.video_blob_id && !meta.hide_video) {
    const videoBlob = await getBlob(recording.video_blob_id);
    if (videoBlob) {
      const videoDataUrl = await blobToDataUrlInline(videoBlob);
      parts.push(`<p><video controls src="${escapeAttr(videoDataUrl)}"></video></p>`);
      parts.push('');
    }
  }

  // Each step
  let stepIdx = 0;
  for (const group of groups) {
    stepIdx += 1;
    if (onProgress) onProgress(stepIdx, groups.length);

    const primary = group[0];
    const title = primary.user_title || primary.ai_title || `Step ${stepIdx}`;
    const description = primary.user_description || primary.ai_description || '';
    const wpHidden = primary.hidden || {};

    if (!wpHidden.title) parts.push(`<h4>${escapeHtml(stepIdx + '. ' + title)}</h4>`);
    if (!wpHidden.description && description) parts.push(renderMarkdown(description));

    // Flatten the screenshot with annotations baked in (skip manual/hidden steps).
    const screenshotBlob = (!wpHidden.image && primary.screenshot_blob_id) ? await getBlob(primary.screenshot_blob_id) : null;
    if (screenshotBlob) {
      const clicks = group
        .filter(s => s.click.bounding_box)   // manual steps have no bounding box
        .map(s => {
          const dpr = s.click.device_pixel_ratio || 1;
          const b = s.click.bounding_box;
          return {
            bounding_box: { x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr },
            label: s.user_title || s.click.element_label || '',
            show_callout: s.click.label_visible === false,
          };
        });
      try {
        const flattenedBlob = await flattenAnnotatedScreenshot(screenshotBlob, clicks);
        const imgDataUrl = await blobToDataUrlInline(flattenedBlob);
        const altText = `Screenshot for step ${stepIdx}: ${title}`;
        parts.push(`<figure><img src="${escapeAttr(imgDataUrl)}" alt="${escapeAttr(altText)}"></figure>`);
      } catch (err) {
        console.error('Failed to flatten screenshot for step', stepIdx, err);
        // Fall back to the raw screenshot if flattening fails
        const rawDataUrl = await blobToDataUrlInline(screenshotBlob);
        parts.push(`<figure><img src="${escapeAttr(rawDataUrl)}" alt="${escapeAttr(`Screenshot for step ${stepIdx}`)}"></figure>`);
      }
    }

    // Sub-step list, when this step represents multiple clicks
    if (group.length > 1) {
      parts.push('<ol>');
      for (const s of group) {
        const subText = s.user_description || s.ai_description || `Click ${s.click.element_label}`;
        parts.push(`  <li>${escapeHtml(subText)}</li>`);
      }
      parts.push('</ol>');
    }

    parts.push(''); // blank line between steps
  }

  return parts.join('\n');
}

// ---- Util ----

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const SLUG_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'by', 'with', 'from', 'is', 'it', 'as', 'up', 'be', 'its',
]);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(w => w && !SLUG_STOP_WORDS.has(w))
    .join('-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'article';
}

// ---- Astro/Starlight Help Center export ----
//
// Produces a ZIP that, when extracted at the repo root, places files at:
//
//   src/content/docs/<category>/<slug>.mdx
//   src/content/docs/<category>/assets/<slug>/step-1.png
//   src/content/docs/<category>/assets/<slug>/step-2.png
//   src/content/docs/<category>/assets/<slug>/walkthrough.webm
//
// Notes on the layout:
//   - The markdown lives in a flat <category>/<slug>.mdx (not nested under
//     <slug>/index.mdx). This matches the actual Astro/Starlight repo
//     structure: each category folder contains .mdx files directly.
//   - Images live under src/content/docs/<category>/assets/<slug>/ in their own subfolder so
//     multiple articles never collide on filenames like step-1.png.
//   - The markdown references images via a relative path: ./assets/<slug>/step-1.png.
//
// Screenshots have annotations flattened in (same approach as the
// WordPress export) so the visual click markers survive on the live site.
//
// Returns { zipBlob, slug, validationErrors } so the caller can:
//   - download the ZIP, or
//   - show validation errors if required fields are missing.

export async function exportAstro(recording, groups, options = {}) {
  const { onProgress, includeVideo = true } = options;

  // Validate spec-required metadata fields
  const meta = recording.meta || {};
  const errors = validateAstroMeta(recording, meta);
  if (errors.length > 0) {
    return { zipBlob: null, slug: null, validationErrors: errors };
  }

  const slug = meta.slug || slugify(recording.title || 'article');
  const today = new Date().toISOString().slice(0, 10);
  const tags = Array.isArray(meta.tags) ? meta.tags : [];

  // Build the markdown body. We accumulate image filenames as we go so we
  // can package them in the images/ folder.
  const imageFiles = new Map(); // filename → Blob
  const bodyLines = [];

  // Frontmatter
  const fm = [
    '---',
    `title: ${yamlString(recording.title || 'Untitled')}`,
    `description: ${yamlString(meta.description)}`,
    `category: ${yamlString(meta.category)}`,
  ];
  if (tags.length > 0) {
    fm.push('tags:');
    for (const t of tags) fm.push(`  - ${yamlString(t)}`);
  }
  fm.push('sidebar:');
  fm.push(`  order: ${typeof meta.sidebar_order === 'number' ? meta.sidebar_order : 999}`);
  fm.push(`lastUpdated: ${today}`);
  fm.push('---');
  fm.push('');
  bodyLines.push(...fm);

  // Intro paragraph. Use the description (the SEO summary) for the intro
  // body when it exists; otherwise fall back to a neutral sentence. Avoids
  // grammatically awkward "how to assigning roles..." mashups.
  if (meta.description && meta.description.trim()) {
    bodyLines.push(meta.description.trim());
  } else {
    bodyLines.push(`This article walks through ${recording.title || 'this workflow'}.`);
  }
  bodyLines.push('');

  // The markdown will live at src/content/docs/<category>/<slug>.mdx.
  // Images live at public/images/<slug>/ so Astro skips sharp processing.
  // We reference them with an absolute path from the site root.
  const assetRef = (filename) => `/images/${slug}/${filename}`;
  // Video uses a content-relative import so it gets its own ref.
  const videoRef  = (filename) => `./assets/${slug}/${filename}`;

  // Optional video reference (embedded video)
  if (includeVideo && recording.video_blob_id && !meta.hide_video) {
    const videoBlob = await getBlob(recording.video_blob_id);
    if (videoBlob) {
      const videoFilename = 'walkthrough.webm';
      imageFiles.set(videoFilename, videoBlob);
      bodyLines.push(`import walkthroughVideo from '${videoRef(videoFilename)}';`);
      bodyLines.push('');
      bodyLines.push(`<video controls src={walkthroughVideo} style={{width: '100%'}}></video>`);
      bodyLines.push('');
    }
  }

  // Steps — each step is a ## heading so Starlight picks them up for
  // the "In This Article" table of contents automatically.
  let stepIdx = 0;
  for (const group of groups) {
    stepIdx += 1;
    if (onProgress) onProgress(stepIdx, groups.length);

    const primary = group[0];
    const title = primary.user_title || primary.ai_title || `Step ${stepIdx}`;
    const description = primary.user_description || primary.ai_description || '';
    const astroHidden = primary.hidden || {};

    // ## heading — omitted (no blank heading) when title is hidden.
    if (!astroHidden.title) {
      bodyLines.push(`## ${title}`);
      bodyLines.push('');
    }

    if (!astroHidden.description && description) {
      bodyLines.push(description);
      bodyLines.push('');
    }

    // Sub-steps as a bullet list when the step has multiple grouped clicks.
    if (group.length > 1) {
      for (const s of group) {
        const subText = s.user_description || s.ai_description || `Click ${s.click.element_label || ''}`;
        bodyLines.push(`- ${subText}`);
      }
      bodyLines.push('');
    }

    // Flatten the screenshot with annotations baked in (skip manual/hidden steps).
    const screenshotBlob = (!astroHidden.image && primary.screenshot_blob_id) ? await getBlob(primary.screenshot_blob_id) : null;
    if (screenshotBlob) {
      const clicks = group
        .filter(s => s.click.bounding_box)   // manual steps have no bounding box
        .map(s => {
          const dpr = s.click.device_pixel_ratio || 1;
          const b = s.click.bounding_box;
          return {
            bounding_box: { x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr },
            label: s.user_title || s.click.element_label || '',
            show_callout: s.click.label_visible === false,
          };
        });
      let pngBlob;
      try {
        pngBlob = await flattenAnnotatedScreenshot(screenshotBlob, clicks);
      } catch (err) {
        console.error('Astro export: flatten failed for step', stepIdx, err);
        pngBlob = screenshotBlob; // fall back to raw screenshot
      }

      const filename = `step-${stepIdx}.png`;
      imageFiles.set(filename, pngBlob);

      const altText = `Step ${stepIdx}: ${title}`;
      bodyLines.push(`![${escapeAltText(altText)}](${assetRef(filename)})`);
      bodyLines.push('');
    }
  }

  // Optional closing note entered by the user in the editor
  const conclusion = (meta.conclusion || '').trim();
  if (conclusion) {
    bodyLines.push(conclusion);
    bodyLines.push('');
  }

  const markdown = bodyLines.join('\n');

  // Build the ZIP with full repo-relative paths so the user can extract it
  // at the help center repo root and have files land in the right places.
  //   src/content/docs/<category>/<slug>.mdx
  //   src/content/docs/<category>/assets/<slug>/<filename>
  const files = new Map();
  const category = (meta.category || '').trim();
  files.set(
    `src/content/docs/${category}/${slug}.mdx`,
    new Blob([markdown], { type: 'text/markdown' })
  );
  for (const [filename, blob] of imageFiles.entries()) {
    // Video stays alongside the MDX; images go to public/ to bypass sharp.
    if (filename.endsWith('.webm')) {
      files.set(`src/content/docs/${category}/assets/${slug}/${filename}`, blob);
    } else {
      files.set(`public/images/${slug}/${filename}`, blob);
    }
  }
  const { makeZip } = await import('./zip.js');
  const zipBlob = await makeZip(files);

  return { zipBlob, slug, validationErrors: [] };
}

// Validate that all spec-required fields are present and well-formed.
function validateAstroMeta(recording, meta) {
  const errors = [];
  if (!recording.title || !recording.title.trim()) {
    errors.push({ field: 'title', message: 'Article title is required.' });
  }
  if (!meta.description || !meta.description.trim()) {
    errors.push({ field: 'description', message: 'Description is required (used for SEO and search snippets).' });
  }
  if (!meta.category || !meta.category.trim()) {
    errors.push({ field: 'category', message: 'Category is required. Pick one from the dropdown or type a custom slug.' });
  } else if (!/^[a-z][a-z0-9-]*$/.test(meta.category.trim())) {
    errors.push({ field: 'category', message: `Category "${meta.category}" must be lowercase letters, numbers, and hyphens only (no spaces).` });
  }
  const slug = meta.slug || slugify(recording.title || '');
  if (!/^[a-z0-9-]+$/.test(slug)) {
    errors.push({ field: 'slug', message: `Slug "${slug}" must contain only lowercase letters, numbers, and hyphens.` });
  }
  if (slug.length > 80) {
    errors.push({ field: 'slug', message: `Slug is ${slug.length} characters — max 80 allowed.` });
  }
  return errors;
}

// YAML string escaping. Simple version — wraps in double-quotes and
// escapes embedded quotes and backslashes. Sufficient for our use case
// (titles, descriptions, tags — no multiline content).
function yamlString(s) {
  const v = String(s == null ? '' : s);
  // Empty or simple alphanumeric values can be unquoted, but quoting is
  // always safe. Always quote for predictability.
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function escapeAltText(s) {
  return String(s || '').replace(/[\[\]]/g, '');
}