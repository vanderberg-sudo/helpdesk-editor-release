// anthropic.js — Thin client for the Anthropic Messages API.
// All AI calls in StepCast go through this.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

export async function getApiKey() {
  const { stepcast_api_key } = await chrome.storage.local.get('stepcast_api_key');
  return stepcast_api_key || null;
}

export async function setApiKey(key) {
  return chrome.storage.local.set({ stepcast_api_key: key });
}

export class NoApiKeyError extends Error {
  constructor() { super('No Anthropic API key set'); this.code = 'NO_API_KEY'; }
}

/**
 * Call Claude with a text prompt and (optionally) one image.
 * @param {string} prompt
 * @param {Blob|null} imageBlob  PNG/JPEG screenshot
 * @returns {Promise<string>} model output text
 */
export async function callClaude(prompt, imageBlob = null) {
  const key = await getApiKey();
  if (!key) throw new NoApiKeyError();

  const content = [];
  if (imageBlob) {
    const base64 = await blobToBase64(imageBlob);
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageBlob.type || 'image/png',
        data: base64,
      },
    });
  }
  content.push({ type: 'text', text: prompt });

  const body = {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        // Backoff and retry
        await sleep(Math.pow(2, attempt) * 500);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${txt}`);
      }
      const data = await res.json();
      // Combine all text content blocks
      const text = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt === 2) throw err;
      await sleep(Math.pow(2, attempt) * 500);
    }
  }
  throw lastErr || new Error('Anthropic call failed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // dataURL = "data:<mime>;base64,<data>"
      const result = reader.result;
      const comma = result.indexOf(',');
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
