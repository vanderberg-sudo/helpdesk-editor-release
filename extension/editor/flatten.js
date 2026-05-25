// flatten.js — Composite a screenshot Blob + an annotation SVG string into
// a single flat PNG Blob. Used by the WordPress export so the rendered
// annotations survive copy-paste (which strips SVG overlays).

import { renderAnnotationsSvg } from './annotations.js';

/**
 * Composite a screenshot + annotations into a single PNG Blob.
 * @param {Blob} screenshotBlob   the raw PNG screenshot
 * @param {Array} clicks          the annotation click data (already DPR-scaled,
 *                                each with bounding_box, label, show_callout)
 * @returns {Promise<Blob>}       a flat PNG with the annotations baked in
 */
export async function flattenAnnotatedScreenshot(screenshotBlob, clicks) {
  if (!screenshotBlob) return null;

  // Load the screenshot at its native resolution
  const screenshotUrl = URL.createObjectURL(screenshotBlob);
  const img = await loadImage(screenshotUrl);
  URL.revokeObjectURL(screenshotUrl);

  const width = img.naturalWidth;
  const height = img.naturalHeight;

  // Build the annotation SVG at the screenshot's native dimensions
  const svgString = renderAnnotationsSvg({ width, height, clicks });

  // Convert the SVG to an Image via data URL (more reliable than blob URLs
  // for SVG content in canvas drawing)
  const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
  const svgImg = await loadImage(svgDataUrl);

  // Composite onto a canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  ctx.drawImage(svgImg, 0, 0, width, height);

  // Export as PNG Blob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null')),
      'image/png'
    );
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Image failed to load: ' + src.slice(0, 60)));
    img.src = src;
  });
}

/**
 * Convert a Blob to a base64 data URL.
 */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
