// grouping.js — Decides whether a new click should be grouped with
// the previous one, or start a new step.
//
// Returns 'group' or 'new'. Pure function for testability.

const GROUPING_WINDOW_MS = 8000;

export function decideGrouping(prevClick, newClick) {
  if (!prevClick) return 'new';

  // Different URL path → always new step
  if (urlPath(prevClick.url) !== urlPath(newClick.url)) return 'new';

  // Too much time elapsed → new step
  const elapsed = newClick.timestamp - prevClick.timestamp;
  if (elapsed > GROUPING_WINDOW_MS) return 'new';

  // Modal opened between clicks → new step
  if (newClick.dom_mutation_since_last) return 'new';

  return 'group';
}

function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
