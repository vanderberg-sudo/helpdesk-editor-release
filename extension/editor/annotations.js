// annotations.js — Shared SVG annotation renderer.
//
// Given a list of clicks (each with bounding_box and label) and the
// screenshot's natural dimensions, produces an SVG string that overlays
// onto the screenshot to show:
//   - A dimming layer over the whole image
//   - A "hole" cut out around each clicked element (spotlight effect)
//   - A blue rounded rectangle outlining each click
//   - A numbered pin badge at the top-left of each click
//   - A label callout pill showing the click's text/label
//
// Used identically by the editor's live preview and by the exported HTML.

const PIN_COLOR = '#185fa5';
const DIM_OPACITY = 0.45;

/**
 * @param {object} opts
 *   width:  number (screenshot width in px)
 *   height: number (screenshot height in px)
 *   clicks: array of { bounding_box: {x,y,w,h}, label: string }
 * @returns {string} SVG markup
 */
export function renderAnnotationsSvg(opts) {
  const { width, height, clicks } = opts;
  if (!clicks || clicks.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }

  // The mask: white = keep dim, black = show through.
  // We start with a fully-white rect (full dim) and punch black rounded
  // rects in for each click area.
  const maskId = 'sc-mask-' + Math.random().toString(36).slice(2, 9);
  const maskHoles = clicks.map(c => {
    const b = c.bounding_box;
    const pad = 8;
    return `<rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + pad * 2}" height="${b.h + pad * 2}" rx="8" ry="8" fill="black"/>`;
  }).join('');

  const outlines = clicks.map(c => {
    const b = c.bounding_box;
    return `<rect x="${b.x - 4}" y="${b.y - 4}" width="${b.w + 8}" height="${b.h + 8}" rx="6" ry="6" fill="none" stroke="${PIN_COLOR}" stroke-width="3"/>`;
  }).join('');

  // Only render label callouts for clicks that explicitly request them
  // (i.e. the click target's label is NOT visible on the page — icon-only
  // buttons, etc). For clicks whose label is already visible, the outline
  // + spotlight are sufficient.
  const callouts = clicks.map(c => c.show_callout ? renderLabelCallout(c, width, height) : '').join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <mask id="${maskId}">
        <rect x="0" y="0" width="${width}" height="${height}" fill="white"/>
        ${maskHoles}
      </mask>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="black" opacity="${DIM_OPACITY}" mask="url(#${maskId})"/>
    ${outlines}
    ${callouts}
  </svg>`;
}

function renderLabelCallout(click, imgWidth, imgHeight) {
  const b = click.bounding_box;
  const label = (click.label || '').trim();
  if (!label) return '';

  // Callout sizing
  const truncated = label.length > 40 ? label.slice(0, 37) + '…' : label;
  const fontSize = Math.max(14, Math.min(20, imgWidth / 90));
  const textWidth = truncated.length * fontSize * 0.58;
  const padX = 14;
  const padY = 8;
  const calloutW = textWidth + padX * 2;
  const calloutH = fontSize + padY * 2;

  // Place above the click rect if there's room; otherwise below.
  const spaceAbove = b.y;
  const spaceBelow = imgHeight - (b.y + b.h);
  const placeAbove = spaceAbove >= calloutH + 20 && spaceAbove >= spaceBelow;
  const calloutY = placeAbove
    ? b.y - calloutH - 10
    : b.y + b.h + 10;

  // Center horizontally on the click, clamped to image bounds.
  let calloutX = b.x + b.w / 2 - calloutW / 2;
  calloutX = Math.max(8, Math.min(imgWidth - calloutW - 8, calloutX));

  const textCx = calloutX + calloutW / 2;
  const textCy = calloutY + calloutH / 2;

  return `
    <rect x="${calloutX}" y="${calloutY}" width="${calloutW}" height="${calloutH}" rx="${calloutH / 2}" ry="${calloutH / 2}"
          fill="${PIN_COLOR}" stroke="white" stroke-width="2"/>
    <text x="${textCx}" y="${textCy}" font-size="${fontSize}" font-weight="600" fill="white"
          text-anchor="middle" dominant-baseline="central"
          font-family="system-ui, -apple-system, sans-serif">${escapeXml(truncated)}</text>
  `;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

/**
 * Load the natural dimensions of an image Blob.
 * Falls back to 1600x900 if loading fails (safety net for the export).
 */
export async function getImageDimensions(blob) {
  if (!blob) return { width: 1600, height: 900 };
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth || 1600, height: img.naturalHeight || 900 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 1600, height: 900 });
    };
    img.src = url;
  });
}
