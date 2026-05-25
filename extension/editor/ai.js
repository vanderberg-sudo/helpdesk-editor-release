// ai.js — Prompts and per-step AI orchestration.
import { callClaude } from './anthropic.js';

export async function generateStepDescription(step, screenshotBlob, urlOrigin) {
  const prompt = `You are writing a how-to article step. The user is documenting how to use the web application at ${urlOrigin}.

In this step, they clicked the element labeled "${step.click.element_label}" on the page ${pathOf(step.click.url)}. Here is the screenshot at the moment of the click.

Write ONE sentence (max 25 words) describing what the user is doing and why. Be action-oriented. Don't just describe what they clicked — explain the intent.

Examples of good descriptions:
- "Open the Portfolio A folder to view its teams."
- "Click the team's menu to see assignment options."

Examples of bad descriptions:
- "Click on Portfolio A." (just restates the click)
- "The user clicks the button." (passive, no intent)

Output the sentence only, no preamble.`;

  return await callClaude(prompt, screenshotBlob);
}

export async function generateGroupTitle(stepsInGroup, urlOrigin) {
  const clicks = stepsInGroup.map((s, i) => `${i + 1}. Clicked "${s.click.element_label}" on ${pathOf(s.click.url)}`).join('\n');
  const prompt = `You are writing the title for a step in a how-to article.

The step consists of these clicks:
${clicks}

Write a short title (max 6 words) summarizing what this step accomplishes. Use sentence case. Don't say "Click..." — describe the goal.

Output the title only.`;
  return await callClaude(prompt);
}

export async function generateArticleTitle(stepTitles, urlOrigin) {
  const list = stepTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `You are titling a how-to article for a web application's help center.

The article documents this sequence of user actions:
${list}

The application is at ${urlOrigin}.

Write a clear, specific title (max 12 words). Start with a verb. Use sentence case. Don't end with a period.

Examples:
- "Assign a team to a schedule in Comparative Agility"
- "Set up two-factor authentication for your account"

Output the title only.`;
  return await callClaude(prompt);
}

export async function generateArticleDescription(articleTitle, stepTitles, urlOrigin) {
  const list = stepTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `You are writing the SEO meta description for a how-to article in a web application's help center.

Article title: "${articleTitle}"
Application: ${urlOrigin}

The article covers these steps:
${list}

Write ONE sentence (max 30 words) that summarises what the reader will learn or accomplish. 
- Write in the second person ("You will learn how to…" or "Learn how to…").
- Be specific, not generic.
- Do not start with "This article".
- No period at the end.

Output the sentence only.`;
  return await callClaude(prompt);
}

export async function generateArticleTags(articleTitle, stepTitles, urlOrigin) {
  const list = stepTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `You are tagging a how-to article for a web application's help center.

Article title: "${articleTitle}"
Application: ${urlOrigin}

The article covers these steps:
${list}

Generate 3–5 lowercase tag keywords that describe the topic. Tags should be single words or short hyphenated phrases (e.g. "admin", "teams", "user-management").

Output only the tags as a comma-separated list, nothing else.`;
  return await callClaude(prompt);
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}
