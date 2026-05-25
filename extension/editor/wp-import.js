// wp-import.js — WordPress XML → Astro MDX converter (browser version)
// Runs entirely client-side: parses XML with DOMParser, downloads images
// via fetch, packages everything into a ZIP using the existing zip.js module.

import { makeZip } from './zip.js';

// ── Category mapping ──────────────────────────────────────────────────────────

const CATEGORY_MAP = {
  '1-how-to-get-started':    'get-started',
  '2-advance-topics':        'advanced-topics',
  '3-general':               'general',
  'account':                 'account',
  'billing':                 'billing',
  'feedback-360':            'feedback-360',
  'instant-insights':        'instant-insights',
  'personal-improvement':    'personal-improvement',
  'privacy-copyright-legal': 'privacy-legal',
  'reports':                 'reports',
};

// ── Slug helpers ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for',
  'of','by','with','from','is','it','as','up','be','its',
]);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(w => w && !STOP_WORDS.has(w))
    .join('-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'article';
}

function yamlStr(s) {
  return `"${String(s || '').replace(/"/g, '\\"')}"`;
}

// ── HTML entities decoder ─────────────────────────────────────────────────────

function decodeEntities(str) {
  const el = document.createElement('textarea');
  el.innerHTML = str;
  return el.value;
}

// ── HTML → Markdown ───────────────────────────────────────────────────────────

function htmlToMarkdown(html) {
  if (!html) return '';

  let md = decodeEntities(html);

  // Strip entry-content wrappers
  md = md.replace(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/gi, '');

  // Strip layout shortcodes
  md = md.replace(/\[video[^\]]*\][^\[]*\[\/video\]/gi, '');
  md = md.replace(/\[\/?(?:calc|20px|38rem|40rem|48rem)[^\]]*\]/gi, '');

  // Headings
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gis, (_, t) => `## ${stripTags(t).trim()}\n\n`);
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gis, (_, t) => `### ${stripTags(t).trim()}\n\n`);
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gis, (_, t) => `#### ${stripTags(t).trim()}\n\n`);

  // Bold / italic
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gis, (_, t) => `**${stripTags(t).trim()}**`);
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gis,           (_, t) => `**${stripTags(t).trim()}**`);
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gis,         (_, t) => `*${stripTags(t).trim()}*`);
  md = md.replace(/<i[^>]*>(.*?)<\/i>/gis,           (_, t) => `*${stripTags(t).trim()}*`);

  // Links
  md = md.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis, (_, href, text) => {
    const cleanHref = href.replace(/https?:\/\/help\.comparativeagility\.com/gi, '').trim();
    const cleanText = stripTags(text).trim();
    if (!cleanText) return '';
    return `[${cleanText}](${cleanHref || '#'})`;
  });

  // Images — token for later resolution
  md = md.replace(/<img[^>]*>/gis, (imgTag) => {
    const srcMatch = imgTag.match(/src=["']([^"']*)["']/i);
    const altMatch = imgTag.match(/alt=["']([^"']*)["']/i);
    const src = srcMatch ? srcMatch[1] : '';
    const alt = altMatch ? altMatch[1] : '';
    return src ? `@@IMG@@${src}@@${alt}@@` : '';
  });

  // Lists
  md = md.replace(/<ul[^>]*>(.*?)<\/ul>/gis, (_, inner) => {
    const items = [...inner.matchAll(/<li[^>]*>(.*?)<\/li>/gis)];
    return items.map(([, t]) => `- ${stripTags(t).trim()}`).join('\n') + '\n\n';
  });
  md = md.replace(/<ol[^>]*>(.*?)<\/ol>/gis, (_, inner) => {
    const items = [...inner.matchAll(/<li[^>]*>(.*?)<\/li>/gis)];
    return items.map(([, t], i) => `${i + 1}. ${stripTags(t).trim()}`).join('\n') + '\n\n';
  });

  // Tables — keep as HTML, strip inline styles
  md = md.replace(/<table[\s\S]*?<\/table>/gis, (match) => {
    const clean = match.replace(/\s*style="[^"]*"/gi, '').replace(/\s*class="[^"]*"/gi, '');
    return `\n<div className="table-wrapper">\n${clean}\n</div>\n\n`;
  });

  // iframes — keep as HTML
  md = md.replace(/<iframe[\s\S]*?<\/iframe>/gis, (match) => {
    return `\n<div className="embed-wrapper" style={{position:'relative',paddingBottom:'56.25%',height:0}}>\n${match}\n</div>\n\n`;
  });

  // Paragraphs / divs
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<\/div>/gi, '\n');
  md = md.replace(/<p[^>]*>/gi, '');
  md = md.replace(/<div[^>]*>/gi, '');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  md = stripTags(md);

  // Clean whitespace
  md = md.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');

  return md;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, '');
}

// ── Description extractor ─────────────────────────────────────────────────────

function extractDescription(content) {
  const text = stripTags(content).replace(/\s+/g, ' ').trim();
  const first = text.slice(0, 200);
  const dotIdx = first.indexOf('. ', 80);
  return (dotIdx > 0 ? first.slice(0, dotIdx + 1) : first.slice(0, 160)).trim();
}

// ── XML parser ────────────────────────────────────────────────────────────────

function getCdata(el) {
  if (!el) return '';
  return (el.textContent || '').trim();
}

function parseXml(xmlText) {
  const parser = new DOMParser();
  return parser.parseFromString(xmlText, 'text/xml');
}

function extractPosts(doc, includeDrafts) {
  const items = [...doc.querySelectorAll('item')];
  return items.filter(item => {
    const type   = getCdata(item.querySelector('post_type'));
    const status = getCdata(item.querySelector('status'));
    if (type !== 'post') return false;
    if (status === 'publish') return true;
    if (includeDrafts && status === 'draft') return true;
    return false;
  });
}

function getCategory(item) {
  const cats = [...item.querySelectorAll('category')];
  for (const cat of cats) {
    const domain   = cat.getAttribute('domain') || '';
    const nicename = cat.getAttribute('nicename') || '';
    if (domain === 'category' && CATEGORY_MAP[nicename]) {
      return CATEGORY_MAP[nicename];
    }
  }
  return null;
}

function getContent(item) {
  // content:encoded — use namespace-safe querySelector workaround
  for (const child of item.children) {
    if (child.localName === 'encoded' && child.namespaceURI && child.namespaceURI.includes('content')) {
      return child.textContent || '';
    }
  }
  return '';
}

function getTitle(item) {
  return getCdata(item.querySelector('title')) || 'Untitled';
}

function getSlug(item) {
  return getCdata(item.querySelector('post_name')) || '';
}

function getDate(item) {
  const raw = getCdata(item.querySelector('post_date'));
  const m   = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

// ── Image downloader ──────────────────────────────────────────────────────────

async function downloadImage(url) {
  const cleanUrl = decodeEntities(url);
  const fullUrl  = cleanUrl.startsWith('http')
    ? cleanUrl
    : `https://help.comparativeagility.com${cleanUrl}`;

  const res = await fetch(fullUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.arrayBuffer();
}

// ── Per-article converter ─────────────────────────────────────────────────────

async function convertPost(item, opts, files, report, log) {
  const title    = getTitle(item);
  const category = getCategory(item);
  const rawSlug  = getSlug(item);
  const slug     = rawSlug || slugify(title);
  const date     = getDate(item);
  const content  = getContent(item);

  // Skip uncategorised or base64-blob posts
  if (!category) {
    report.skipped.push({ title, reason: 'No mapped category' });
    log(`⚠ Skipped: ${title} — no mapped category`, 'warn');
    return;
  }
  if (content.includes('data:video/') || content.includes('data:image/')) {
    report.skipped.push({ title, reason: 'Contains embedded base64 blob' });
    log(`⚠ Skipped: ${title} — embedded base64 blob`, 'warn');
    return;
  }

  let md = htmlToMarkdown(content);

  // Collect image tokens
  const imgTokens = [...md.matchAll(/@@IMG@@([^@]+)@@([^@]*)@@/g)];
  const imgMap    = new Map();

  let imgIdx = 0;
  for (const [, src] of imgTokens) {
    if (imgMap.has(src)) continue;
    if (!src.includes('wp-content/uploads') && !src.startsWith('/wp-content')) {
      imgMap.set(src, src); // keep external URLs
      continue;
    }

    imgIdx++;
    const ext      = (src.split('?')[0].match(/\.(png|jpg|jpeg|gif|webp)$/i) || ['.png'])[0].toLowerCase();
    const filename = `image-${imgIdx}${ext}`;
    const zipPath  = `public/images/${slug}/${filename}`;
    const relPath  = `/images/${slug}/${filename}`;

    if (opts.downloadImages) {
      try {
        const buf = await downloadImage(src);
        files.set(zipPath, new Blob([buf]));
        imgMap.set(src, relPath);
        report.imagesDownloaded++;
      } catch (err) {
        imgMap.set(src, src); // fall back to original URL
        report.imageErrors++;
        log(`  ✗ Image failed: ${filename} — ${err.message}`, 'err');
      }
    } else {
      imgMap.set(src, src);
    }
  }

  // Replace tokens
  md = md.replace(/@@IMG@@([^@]+)@@([^@]*)@@/g, (_, src, alt) => {
    const localPath = imgMap.get(src) || src;
    const altText   = (alt || '').trim() || src.split('/').pop().replace(/\.[^.]+$/, '');
    return `![${altText}](${localPath})`;
  });

  const description = extractDescription(content);

  const mdxContent = [
    '---',
    `title: ${yamlStr(title)}`,
    `description: ${yamlStr(description)}`,
    'sidebar:',
    '  order: 999',
    `lastUpdated: ${date}`,
    '---',
    '',
    md,
    '',
  ].join('\n');

  files.set(`${category}/${slug}.mdx`, mdxContent);

  report.converted.push({ title, category, slug, images: imgIdx });
  log(`✓ ${title}`, 'ok');
}

// ── Report generator ──────────────────────────────────────────────────────────

function buildReport(report) {
  const lines = [
    '═══════════════════════════════════════════════════════',
    '  WordPress → Astro Conversion Report',
    `  ${new Date().toLocaleString()}`,
    '═══════════════════════════════════════════════════════',
    '',
    `  Converted : ${report.converted.length}`,
    `  Skipped   : ${report.skipped.length}`,
    `  Images    : ${report.imagesDownloaded} downloaded, ${report.imageErrors} failed`,
    '',
  ];

  const byCat = {};
  for (const a of report.converted) {
    if (!byCat[a.category]) byCat[a.category] = [];
    byCat[a.category].push(a);
  }
  for (const [cat, articles] of Object.entries(byCat).sort()) {
    lines.push(`  ${cat.toUpperCase()} (${articles.length})`);
    for (const a of articles) {
      const imgs = a.images > 0 ? ` [${a.images} images]` : '';
      lines.push(`    ✓  ${a.title}${imgs}`);
    }
    lines.push('');
  }

  if (report.skipped.length > 0) {
    lines.push('  SKIPPED');
    for (const s of report.skipped) {
      lines.push(`    ✗  ${s.title} — ${s.reason}`);
    }
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════');
  return lines.join('\n');
}

// ── UI ────────────────────────────────────────────────────────────────────────

let xmlFile      = null;
let mode         = 'test';
let resultZip    = null;
let resultReport = '';

const dropZone    = document.getElementById('drop-zone');
const xmlInput    = document.getElementById('xml-input');
const dropHint    = document.getElementById('drop-hint');
const convertBtn  = document.getElementById('convert-btn');
const progressCard = document.getElementById('progress-card');
const progressStatus = document.getElementById('progress-status');
const progressBar  = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const logEl       = document.getElementById('log');
const resultCard  = document.getElementById('result-card');
const uploadCard  = document.getElementById('upload-card');

// Mode buttons
for (const btn of document.querySelectorAll('.mode-btn')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mode = btn.dataset.mode;
  });
}

// File input
function setFile(file) {
  xmlFile = file;
  dropZone.classList.add('has-file');
  dropHint.textContent = `✓ ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  convertBtn.disabled = false;
}

xmlInput.addEventListener('change', () => { if (xmlInput.files[0]) setFile(xmlInput.files[0]); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.xml')) setFile(file);
});

// Manage Articles link
document.getElementById('manage-link').addEventListener('click', () => {
  window.open(chrome.runtime.getURL('editor/manage.html'), '_blank');
});

// Log helper
function appendLog(msg, type = 'info') {
  const span = document.createElement('span');
  span.className = `log-line log-${type}`;
  span.textContent = msg;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

// Convert button
convertBtn.addEventListener('click', async () => {
  if (!xmlFile) return;

  // Switch to progress view
  uploadCard.style.display = 'none';
  progressCard.classList.add('visible');
  resultCard.classList.remove('visible');
  logEl.innerHTML = '';
  progressBar.style.width = '0%';

  const opts = {
    downloadImages: document.getElementById('opt-images').checked,
    includeDrafts:  document.getElementById('opt-drafts').checked,
  };

  const report = {
    converted: [], skipped: [],
    imagesDownloaded: 0, imageErrors: 0,
  };

  const files = new Map(); // zipPath → string | Uint8Array

  try {
    // Parse XML
    progressStatus.textContent = 'Parsing XML…';
    const xmlText = await xmlFile.text();
    const doc     = parseXml(xmlText);

    let posts = extractPosts(doc, opts.includeDrafts);
    appendLog(`Found ${posts.length} posts`, 'info');

    // Test mode: pick 4 representative articles
    if (mode === 'test') {
      const wantSlugs = new Set(['assigning-roles', 'how-do-i-change-my-password', 'user-management']);
      const picks = [];
      let gotRemapped = false;
      for (const p of posts) {
        const slug = getSlug(p);
        const cat  = getCategory(p);
        if (wantSlugs.has(slug)) picks.push(p);
        if (!gotRemapped && cat === 'get-started' && !wantSlugs.has(slug)) {
          picks.push(p); gotRemapped = true;
        }
      }
      for (const p of posts) {
        if (picks.length >= 4) break;
        if (!picks.includes(p)) picks.push(p);
      }
      posts = picks.slice(0, 4);
      appendLog(`Test mode: converting ${posts.length} sample articles`, 'info');
    }

    const total = posts.length;
    progressStatus.textContent = `Converting ${total} article${total !== 1 ? 's' : ''}…`;

    for (let i = 0; i < posts.length; i++) {
      const title = getTitle(posts[i]);
      progressLabel.textContent = `${i + 1} / ${total} — ${title.slice(0, 60)}`;
      progressBar.style.width = `${Math.round(((i + 1) / total) * 90)}%`;
      await convertPost(posts[i], opts, files, report, appendLog);
      // Yield to UI
      await new Promise(r => setTimeout(r, 0));
    }

    // Add conversion report
    progressStatus.textContent = 'Building ZIP…';
    const reportText = buildReport(report);
    files.set('conversion-report.txt', reportText);

    progressBar.style.width = '95%';

    // Build ZIP
    resultZip    = await makeZip(files);
    resultReport = reportText;

    progressBar.style.width = '100%';
    progressStatus.textContent = 'Done!';

    // Show result card
    showResult(report, mode === 'test');

  } catch (err) {
    appendLog(`Fatal error: ${err.message}`, 'err');
    progressStatus.textContent = 'Conversion failed — see log above';
    console.error(err);
  }
});

function showResult(report, isTest) {
  progressCard.classList.remove('visible');
  resultCard.classList.add('visible');

  const summary = document.getElementById('result-summary');
  summary.textContent = isTest
    ? `Test complete — ${report.converted.length} articles converted`
    : `✓ ${report.converted.length} articles converted`;

  const statsEl = document.getElementById('result-stats');
  statsEl.innerHTML = [
    stat(report.converted.length, 'Converted'),
    stat(report.skipped.length, 'Skipped'),
    stat(report.imagesDownloaded, 'Images downloaded'),
    report.imageErrors > 0 ? stat(report.imageErrors, 'Image failures') : '',
  ].join('');

  const resultLog = document.getElementById('result-log');
  resultLog.textContent = resultReport;

  // Download button
  document.getElementById('download-btn').onclick = () => {
    const url = URL.createObjectURL(resultZip);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = isTest ? 'wp-import-test.zip' : 'wp-import-full.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // Reset button
  document.getElementById('reset-btn').onclick = () => {
    resultCard.classList.remove('visible');
    uploadCard.style.display = '';
    logEl.innerHTML = '';
    xmlFile = null;
    resultZip = null;
    dropZone.classList.remove('has-file');
    dropHint.textContent = 'WordPress export .xml file';
    convertBtn.disabled = true;
  };
}

function stat(num, label) {
  return `<div class="stat">
    <span class="stat-num">${num}</span>
    <span class="stat-label">${label}</span>
  </div>`;
}