import { normalizeKey } from './model.js';

export function parsePRMetadata(html, key) {
  const [, number] = normalizeKey(key).split('#');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let data;
  const embedded = doc.querySelector('script[data-target="react-app.embeddedData"]');
  if (embedded) {
    try { data = JSON.parse(embedded.textContent).payload?.pullRequestsLayoutRoute?.pullRequest; }
    catch { /* Legacy pages can still provide the visible header fields. */ }
  }
  if (data && Number(data.number) !== Number(number)) throw new Error('GitHub returned a different PR.');
  const title = typeof data?.title === 'string' ? data.title : doc.querySelector('.js-issue-title')?.textContent;
  if (!title?.trim()) throw new Error('PR details are unavailable. Open the PR to check access, then retry.');
  const author = typeof data?.author?.login === 'string' ? data.author.login
    : doc.querySelector('meta[property="og:author:username"]')?.content || doc.querySelector('.gh-header-meta .author')?.textContent;
  // Base is the merge target, not the contributor's head/source branch.
  const base = typeof data?.baseBranch === 'string' ? data.baseBranch
    : doc.querySelector('.base-ref .css-truncate-target, .base-ref')?.textContent;
  let state = typeof data?.state === 'string' ? data.state.toLowerCase() : 'unknown';
  if (!data) for (const value of ['merged', 'closed', 'open', 'draft']) {
    if (doc.querySelector(`.gh-header-meta .State--${value}`)) { state = value; break; }
  }
  if (!['open', 'closed', 'merged', 'draft'].includes(state)) state = 'unknown';
  return {
    title: title.trim().slice(0, 500),
    author: typeof author === 'string' ? author.trim().slice(0, 100) : '',
    base: typeof base === 'string' ? base.trim().slice(0, 255) : '',
    state
  };
}

export async function loadPRMetadata(key, signal) {
  const [repository, number] = normalizeKey(key).split('#');
  const url = new URL(`https://github.com/${repository}/pull/${number}`);
  const response = await fetch(url.href, {
    credentials: 'include', headers: { Accept: 'text/html' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}. Open the PR to check access or retry.`);
  const final = new URL(response.url);
  if (final.origin !== url.origin || final.pathname.replace(/\/$/, '').toLowerCase() !== url.pathname) {
    throw new Error('GitHub redirected this PR. Open it to check access, then retry.');
  }
  return parsePRMetadata(await response.text(), key);
}
